"""Explicit, password-authenticated, read-only commissioning checks over OpenSSH."""
import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sys
import tempfile
import time
import uuid

from aiohttp import web

# No remote file transfer, hardware access, shell interpolation of user text or service mutation.
REMOTE = r'''
import grp,json,os,platform,pwd,shutil,socket,stat,subprocess,time
from pathlib import Path

def read(path):
 try:return Path(path).read_text()[:12000].strip()
 except (OSError,UnicodeError):return None

def command(args):
 try:
  p=subprocess.run(args,capture_output=True,text=True,timeout=5)
  return dict(exit_code=p.returncode,stdout=p.stdout[:12000],stderr=p.stderr[:3000])
 except (OSError,subprocess.TimeoutExpired) as e:return dict(error=str(e))

def device(path):
 try:
  p=Path(path);s=p.stat()
  return dict(target=str(p.resolve()),mode=oct(stat.S_IMODE(s.st_mode)),uid=s.st_uid,gid=s.st_gid,
              readable=os.access(path,os.R_OK),writable=os.access(path,os.W_OK),socket=stat.S_ISSOCK(s.st_mode))
 except OSError as e:return dict(error=str(e))

kind=CHECK_KIND
result=dict(check=kind,hostname=socket.gethostname(),user=pwd.getpwuid(os.getuid()).pw_name,
            kernel=platform.release(),architecture=platform.machine(),remote_time=time.time(),read_only=True)
if kind=='system':
 result.update(os_release=read('/etc/os-release'),armbian_release=read('/etc/armbian-release'),
               machine_id=read('/etc/machine-id'),boot_id=read('/proc/sys/kernel/random/boot_id'),
               memory=read('/proc/meminfo'),uptime=read('/proc/uptime'),disk=dict(zip(('total','used','free'),shutil.disk_usage('/'))),
               root_mount=command(['findmnt','-no','SOURCE,FSTYPE,OPTIONS','/']),network=command(['ip','-j','address','show']))
elif kind=='interfaces':
 result.update(devices={p:device(p) for p in ['/dev/openchicken-dxl','/dev/i2c-openchicken']},
               groups=[grp.getgrgid(g).gr_name for g in os.getgroups()],
               aliases=read('/etc/udev/rules.d/99-openchicken-hat.rules'),
               audio_cards=read('/proc/asound/cards'),modules=command(['lsmod']))
elif kind=='audio':
 result.update(cards=read('/proc/asound/cards'),pcm=read('/proc/asound/pcm'),
               playback=command(['aplay','-l']),capture=command(['arecord','-l']),
               scope='Enumeration only; no playback or recording has been performed.')
elif kind=='services':
 result.update(sockets={p:device(p) for p in ['/run/robotd/robotd.sock','/run/tofd/tofd.sock']},
               services=command(['systemctl','show','robotd.service','tofd.service','openchicken-agent.service',
                                 '--property=Id,LoadState,ActiveState,SubState,User,FragmentPath']),
               listeners=command(['ss','-ltn']),scope='Status only; no services started, stopped or enabled.')
print(json.dumps(result,ensure_ascii=True))
'''
CHECKS = {'system': 'N01', 'interfaces': 'N02', 'audio': 'N04', 'services': 'N05', 'initialization': 'SETUP', **{'stage_'+s:s for s in ('N01','N02','N04','N05','N06')}}


def check_script(kind, context=None):
    if kind == 'initialization' or kind.startswith('stage_'):
        return Path(__file__).with_name('initialization_probe.py').read_text() + '\nprint(json.dumps(collect(' + repr(context) + ', ' + repr(kind[6:] if kind.startswith('stage_') else None) + ')))\n'
    return REMOTE.replace('CHECK_KIND', repr(kind))


def stamp():
    return datetime.now(timezone.utc).isoformat()


def private_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.write-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


class SshChecks:
    def __init__(self, registry):
        self.registry = registry
        self.root = registry.path.parent/'commissioning'
        self.tasks = set()
        self.active = set()
        self.scans = {}
        self.processes = set()
        self.latest = {}
        self.latest_initialization = {}
        self.latest_stages = {}
        jobs = self.root/'jobs'
        if jobs.exists():
            for path in sorted(jobs.glob('*.json'), key=lambda p:p.stat().st_mtime):
                job = json.loads(path.read_text())
                if job['status'] in ('queued', 'running'):
                    job.update(status='interrupted', finished_at=stamp(), error='Host restarted; remote completion not confirmed. No automatic retry.')
                    private_json(path, job)
                self.latest[job['profile_id']] = job['id']
                if job.get('check') == 'initialization': self.latest_initialization[job['profile_id']] = job['id']
                if job.get('check','').startswith('stage_'): self.latest_stages.setdefault(job['profile_id'],{})[job['stage']]=job['id']

    def profile(self, identity):
        row = next((r for r in self.registry.public()['robots'] if r['id'] == identity), None)
        if row is None:
            raise ValueError('Create and save a robot dossier first')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', row['address']):
            raise ValueError('Enter the actual robot IP or hostname')
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}', row['ssh_user']):
            raise ValueError('Enter the actual Linux SSH user')
        return row

    @staticmethod
    def target(row):
        return dict(address=row['address'], port=row['ssh_port'], user=row['ssh_user'])

    def trust_path(self, identity):
        if not re.fullmatch(r'[0-9a-f]{32}', identity):
            raise ValueError('Invalid profile ID')
        return self.root/'trust'/(identity+'.json')

    def trusted(self, row):
        path = self.trust_path(row['id'])
        trust = json.loads(path.read_text()) if path.exists() else None
        return trust if trust and trust['target'] == self.target(row) else None

    async def process(self, argv, timeout, env=None):
        process = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env, start_new_session=True)
        self.processes.add(process)
        async def limited(reader):
            data = bytearray()
            while chunk := await reader.read(8192):
                data.extend(chunk)
                if len(data)>131072:
                    raise ValueError('Remote output exceeded the read-only check limit')
            return data.decode('utf-8', errors='replace')
        readers = [asyncio.create_task(limited(process.stdout)), asyncio.create_task(limited(process.stderr))]
        try:
            stdout, stderr = await asyncio.wait_for(asyncio.gather(*readers), timeout)
            code = await asyncio.wait_for(process.wait(), 2)
            return code, stdout, stderr
        finally:
            if process.returncode is None:
                try:os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:pass
                await process.wait()
            for task in readers:
                task.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            self.processes.discard(process)

    async def scan(self, identity):
        row = self.profile(identity)
        if identity in self.active:
            raise ValueError('Another SSH task is running for this robot')
        self.active.add(identity)
        try:
            code, output, error = await self.process(['/usr/bin/ssh-keyscan','-T','5','-p',str(row['ssh_port']),
                '-t','ed25519',row['address']], 12)
            keys = []
            for line in output.splitlines():
                parts = line.split()
                if len(parts)!=3 or parts[1] not in ('ssh-ed25519','ecdsa-sha2-nistp256','ssh-rsa'):
                    continue
                raw = base64.b64decode(parts[2], validate=True)
                fingerprint = 'SHA256:'+base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip('=')
                item = dict(type=parts[1], key=parts[2], fingerprint=fingerprint)
                if item not in keys:keys.append(item)
            if not keys:
                raise ValueError('No SSH host key received. Check IP, SSH service, port and network. '+error[-1000:])
            token = uuid.uuid4().hex
            self.scans[identity] = dict(token=token, target=self.target(row), keys=keys, expires=time.monotonic()+300)
            return dict(token=token, target=self.target(row), keys=[{k:v for k,v in key.items() if k!='key'} for key in keys])
        finally:
            self.active.discard(identity)

    def confirm(self, identity, token):
        row = self.profile(identity)
        scan = self.scans.get(identity)
        if not scan or scan['token']!=token or scan['expires']<time.monotonic() or scan['target']!=self.target(row):
            raise ValueError('Host-key scan expired or connection settings changed; scan again')
        trust = dict(target=scan['target'], keys=scan['keys'], confirmed_at=stamp())
        private_json(self.trust_path(identity), trust)
        del self.scans[identity]
        return {'trusted': True}

    def status(self, identity):
        row = self.profile(identity)
        trust = self.trusted(row)
        return dict(trusted=bool(trust), target=self.target(row), busy=identity in self.active,
                    fingerprints=[dict(type=k['type'],fingerprint=k['fingerprint']) for k in trust['keys']] if trust else [],
                    latest_stages=self.latest_stages.get(identity,{}), latest_job=self.latest.get(identity), latest_initialization=self.latest_initialization.get(identity))

    def job(self, identity):
        if not re.fullmatch(r'[0-9a-f]{32}', identity):
            raise ValueError('Invalid job ID')
        path = self.root/'jobs'/(identity+'.json')
        if not path.exists():raise ValueError('Job not found')
        return json.loads(path.read_text())

    def start(self, identity, kind, password):
        row = self.profile(identity)
        trust = self.trusted(row)
        if kind not in CHECKS:raise ValueError('Unknown read-only check')
        if not trust:raise ValueError('Verify and confirm the SSH host fingerprint first')
        if identity in self.active:raise ValueError('Another SSH task is running for this robot')
        if not isinstance(password,str) or not password or len(password)>1024 or any(c in password for c in '\r\n\x00'):
            raise ValueError('Enter a password for this check; it will not be stored')
        context = None
        if kind == 'initialization' or kind.startswith('stage_'):
            from host.management_jobs import settings
            config = settings(row)
            context = {key: config[key] for key in ('deploy_root', 'robot_config', 'pad_config', 'robot_socket', 'config_socket')}
            context['robot_id'] = row['robot_id']
        job = dict(id=uuid.uuid4().hex,profile_id=identity,robot_id=row['robot_id'],target=self.target(row),
                   expected_hostname=row['hostname'],check=kind,stage=CHECKS[kind],status='queued',created_at=stamp(),
                   collector_sha256=hashlib.sha256(check_script(kind, context).encode()).hexdigest(),
                   check_context=context,
                   read_only=True,log=['Read-only check queued. No hardware, configuration or services will be changed.'])
        private_json(self.root/'jobs'/(job['id']+'.json'), job)
        self.latest[identity]=job['id'];self.active.add(identity)
        if kind == 'initialization': self.latest_initialization[identity] = job['id']
        if kind.startswith('stage_'): self.latest_stages.setdefault(identity,{})[job['stage']]=job['id']
        task=asyncio.create_task(self.execute(job,trust,password))
        self.tasks.add(task);task.add_done_callback(self.tasks.discard)
        return job

    async def execute(self, job, trust, password):
        path=self.root/'jobs'/(job['id']+'.json')
        server=None
        try:
            job.update(status='running',started_at=stamp());job['log'].append('Connecting with a pinned host key and password authentication.')
            private_json(path,job)
            # Short private paths avoid AF_UNIX path-length limits. No password is written here.
            with tempfile.TemporaryDirectory(prefix='openchicken-ssh-') as directory:
                directory=Path(directory);sock=directory/'askpass.sock'
                attempts=0
                async def answer(reader,writer):
                    nonlocal attempts
                    try:
                        request=await asyncio.wait_for(reader.readline(),3)
                        if request==b'password\n' and attempts==0:
                            attempts+=1;writer.write(password.encode()+b'\n');await writer.drain()
                    finally:
                        writer.close();await writer.wait_closed()
                server=await asyncio.start_unix_server(answer,path=str(sock))
                known=directory/'known_hosts'
                host=job['target']['address'];port=job['target']['port']
                host=f'[{host}]:{port}' if port!=22 else host
                known.write_text(''.join(f"{host} {k['type']} {k['key']}\n" for k in trust['keys']))
                helper=directory/'askpass'
                helper.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(Path(__file__).with_name('ssh_askpass.py')))+' "$@"\n')
                helper.chmod(0o700)
                env=dict(os.environ,SSH_ASKPASS=str(helper),SSH_ASKPASS_REQUIRE='force',DISPLAY='openchicken:0',OPENCHICKEN_ASKPASS_SOCKET=str(sock),LC_ALL='C')
                script=check_script(job['check'], job.get('check_context'))
                argv=['/usr/bin/ssh','-F','/dev/null','-T','-a','-x','-p',str(port),'-l',job['target']['user'],
                      '-o','ConnectTimeout=8','-o','ConnectionAttempts=1','-o','StrictHostKeyChecking=yes',
                      '-o','UserKnownHostsFile='+str(known),'-o','GlobalKnownHostsFile=/dev/null',
                      '-o','UpdateHostKeys=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no',
                      '-o','PreferredAuthentications=password','-o','PubkeyAuthentication=no','-o','NumberOfPasswordPrompts=1',
                      '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2',job['target']['address'],
                      'python3 -c '+shlex.quote(script)]
                code,stdout,stderr=await self.process(argv,90 if job['check']=='initialization' or job['check'].startswith('stage_') else 35,env)
                # Defense in depth: never persist the authentication string, including in diagnostics.
                stderr=stderr.replace(password,'[redacted]')
                if code:
                    raise ValueError(f'SSH/check exit {code}: '+stderr[-3000:]+('\n'+stdout[-1000:] if stdout else ''))
                try:result=json.loads(stdout)
                except ValueError:raise ValueError('SSH connected but the check did not return valid JSON. Verify Python 3 on the robot.')
                if not isinstance(result,dict) or result.get('check')!=job['check'] or not isinstance(result.get('hostname'),str):
                    raise ValueError('Unexpected check response')
                mismatch=bool(job['expected_hostname'] and result['hostname']!=job['expected_hostname'])
                def redact(value):
                    if isinstance(value,str):return value.replace(password,'[redacted]')
                    if isinstance(value,dict):return {k:redact(v) for k,v in value.items()}
                    if isinstance(value,list):return [redact(v) for v in value]
                    return value
                job.update(status='completed',result=redact(result),hostname_matches=not mismatch)
                job['log'].append('Read-only collection completed. Hardware acceptance remains an operator decision.')
                if mismatch:job['log'].append('Hostname differs from the dossier. Verify identity before updating the dossier.')
        except asyncio.CancelledError:
            job.update(status='interrupted',error='Host stopped; remote completion not confirmed. No automatic retry.')
            raise
        except Exception as error:
            text=str(error) or type(error).__name__
            job.update(status='failed',error=text.replace(password,'[redacted]'))
            job['log'].append('Check did not complete. No automatic retry.')
        finally:
            if server:
                server.close();await server.wait_closed()
            job['finished_at']=stamp()
            private_json(path,job)
            self.active.discard(job['profile_id'])
            password=None

    async def close(self, app):
        for task in list(self.tasks):task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)


def install_ssh_checks(app, registry):
    checks=SshChecks(registry)
    app.on_cleanup.append(checks.close)
    async def handler(request):
        try:
            if request.method=='GET':
                if 'job' in request.match_info:return web.json_response(checks.job(request.match_info['job']),headers={'Cache-Control':'no-store'})
                return web.json_response(checks.status(request.match_info['profile']),headers={'Cache-Control':'no-store'})
            if request.headers.get('Origin') not in (f'http://{request.host}',f'https://{request.host}'):
                raise web.HTTPForbidden(text='Same-origin requests only')
            if request.content_type!='application/json':raise web.HTTPUnsupportedMediaType()
            body=await request.json()
            if not isinstance(body,dict):raise ValueError('Expected a JSON object')
            identity=body.get('profile_id');action=request.match_info['action']
            if action=='scan':result=await checks.scan(identity)
            elif action=='trust':result=checks.confirm(identity,body.get('token'))
            elif action=='run':result=checks.start(identity,body.get('check'),body.get('password'))
            else:raise ValueError('Unknown SSH operation')
            return web.json_response(result)
        except (ValueError,TypeError,OSError,asyncio.TimeoutError) as error:
            return web.json_response({'error':str(error) or 'SSH request timed out'},status=400)
    app.router.add_get('/api/commissioning/ssh/status/{profile}',handler)
    app.router.add_get('/api/commissioning/ssh/jobs/{job}',handler)
    app.router.add_post('/api/commissioning/ssh/{action}',handler)
    return checks
