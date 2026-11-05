"""Pinned SSH sessions and durable management jobs, sharing the commissioning busy gate."""
import asyncio
from contextlib import asynccontextmanager
import copy
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

from host.ssh_checks import private_json, stamp


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{32}', value):
        raise ValueError('Invalid record ID')
    return value


def absolute(value):
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in Path(value).parts or value == '/':
        raise ValueError('Use an absolute Linux path without spaces or ..')
    return value.rstrip('/')


def settings(row):
    root = '/home/' + (row['ssh_user'] or row['robot_id']) + '/openchicken_deploy'
    return dict(deploy_root=root, admin_user='root', robotctl=root+'/current/bin/robotctl',
                robot_config=root+'/config/robotd.toml', pad_config=root+'/config/robotd.toml', model_root=root+'/user-policies',
                robot_socket='/run/robotd/robotd.sock', config_socket='/run/configd/configd.sock') | row.get('management_settings', {})


class NativeFailure(ValueError):
    pass


def program_evidence(row):
    section = row.get('program_deployment', {})
    entries = [section[key] for key in ('last_query', 'last_change') if section.get(key)]
    if not entries: return None
    entry = max(entries, key=lambda value: value.get('queried_at', ''))
    result = entry.get('result', {})
    if result.get('status') != 'success' or not result.get('build_id'):
        return dict(unknown_job=entry.get('job_id'))
    return dict(target=entry.get('target'), build_id=result['build_id'],
                current_release=result.get('current_release'), settings=entry.get('settings'))


class ManagementJobs:
    def __init__(self, checks):
        self.checks = checks
        self.registry = checks.registry
        self.root = checks.root/'management'
        self.tasks = set()
        self.tokens = {}
        self.latest = {}
        for path in sorted((self.root/'jobs').glob('*.json'), key=lambda p: p.stat().st_mtime):
            job = json.loads(path.read_text())
            if job['status'] in ('queued', 'running'):
                job.update(status='unknown', finished_at=stamp(), error='Host restarted; query actual state before another change.')
                private_json(path, job)
            self.latest[job['profile_id']] = job['id']

    def save(self, job):
        private_json(self.root/'jobs'/(job['id']+'.json'), job)

    def job(self, identity):
        path = self.root/'jobs'/(identifier(identity)+'.json')
        if not path.exists(): raise ValueError('Operation not found')
        return json.loads(path.read_text())

    def row(self, identity):
        row=next((r for r in self.registry.public()['robots'] if r['id']==identity),None)
        if row is None: raise ValueError('Create and save a robot dossier first')
        return row

    def context(self, identity):
        row = self.checks.profile(identity)
        return dict(profile_id=row['id'], robot_id=row['robot_id'], hostname=row['hostname'],
                    target=self.checks.target(row), settings=settings(row))

    def unresolved(self, identity, operation):
        group = 'configd' if operation.startswith('configd_') else 'program' if operation.startswith('program_') else 'pad' if operation in ('pad_status','pad_pair','pad_forget') else 'policy'
        target = self.context(identity)['target']
        for path in (self.root/'jobs').glob('*.json'):
            job = json.loads(path.read_text())
            other = 'configd' if job['operation'].startswith('configd_') else 'program' if job['operation'].startswith('program_') else 'pad' if job['operation'] in ('pad_status','pad_pair','pad_forget') else 'policy'
            if job['profile_id'] == identity and job.get('target') == target and other == group and job.get('mutation_started') and job['status'] == 'unknown' and not job.get('resolved_by'):
                return True
        return False

    def resolve(self, job):
        if job['operation'] not in ('program_status', 'refresh', 'pad_status', 'configd_inspect'): return
        group = 'configd' if job['operation'].startswith('configd_') else 'program' if job['operation'].startswith('program_') else 'pad' if job['operation'] in ('pad_status','pad_pair','pad_forget') else 'policy'
        for path in (self.root/'jobs').glob('*.json'):
            old = json.loads(path.read_text())
            other = 'configd' if old['operation'].startswith('configd_') else 'program' if old['operation'].startswith('program_') else 'pad' if old['operation'] in ('pad_status','pad_pair','pad_forget') else 'policy'
            if old['profile_id'] == job['profile_id'] and old.get('target') == job['target'] and other == group and old['status'] == 'unknown' and not old.get('resolved_by'):
                old['resolved_by'] = job['id']; self.save(old)

    def preview(self, identity, operation, detail):
        if operation not in ('program_status', 'refresh', 'pad_status', 'configd_inspect', 'joint_readback') and self.unresolved(identity, operation):
            raise ValueError('A previous change has an unknown result; query actual state first')
        context = self.context(identity)
        token = uuid.uuid4().hex
        self.tokens = {key:value for key,value in self.tokens.items() if value['expires'] >= time.monotonic()}
        self.tokens[token] = dict(context=context, operation=operation, detail=copy.deepcopy(detail), expires=time.monotonic()+300)
        return dict(token=token, context=context, operation=operation, detail=detail,
                    expires_in=300, note='No change has been executed. Confirm this target and operation.')

    def consume(self, identity, token):
        preview = self.tokens.pop(token, None)
        if not preview or preview['expires'] < time.monotonic() or preview['context'] != self.context(identity):
            raise ValueError('Preview expired or robot settings changed; preview again')
        return preview

    def start(self, identity, token, password, execute):
        row = self.checks.profile(identity)
        trust = self.checks.trusted(row)
        if not trust: raise ValueError('Verify and confirm the SSH fingerprint in New robot tests first')
        if identity in self.checks.active: raise ValueError('Another SSH or management task is running for this robot')
        if not isinstance(password, str) or not password or len(password)>1024 or any(c in password for c in '\r\n\x00'):
            raise ValueError('Enter the SSH password for this task; it is not stored')
        preview = self.consume(identity, token)
        if preview['operation'] not in ('program_status', 'refresh', 'pad_status', 'configd_inspect', 'joint_readback') and self.unresolved(identity, preview['operation']):
            raise ValueError('Query actual state before another change')
        job = dict(id=uuid.uuid4().hex, **preview['context'], operation=preview['operation'], detail=preview['detail'],
                   status='queued', created_at=stamp(), log=[], config_result='not_attempted',
                   load_result='not_attempted', motion_test='untested')
        self.save(job)
        self.checks.active.add(identity)
        self.latest[identity] = job['id']
        task = asyncio.create_task(self.execute(job, trust, password, execute))
        self.tasks.add(task); task.add_done_callback(self.tasks.discard)
        return job

    def append_log(self, job, lines):
        if not lines: return
        path=self.root/'logs'/(job['id']+'.log')
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
        with os.fdopen(fd,'a') as output: output.write('\n'.join(lines)+'\n')
        job['log_file']='logs/'+path.name
        job['log']=(job['log']+lines)[-300:]
        self.save(job)

    async def process(self, argv, timeout, job, password='', env=None, sha256_fields=()):
        process = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env, start_new_session=True)
        buffers = [bytearray(), bytearray()]
        def redact(text): return text.replace(password, '[redacted]') if password else text
        async def read(reader, index):
            pending = b''
            while chunk := await reader.read(4096):
                buffers[index].extend(chunk)
                if len(buffers[index]) > 2*1024*1024: raise ValueError('Command output limit exceeded')
                pending += chunk
                # Only log complete lines, so a password split between reads is still redacted.
                lines=[]
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    lines.append(redact(line.decode(errors='replace')))
                self.append_log(job,lines)
            if pending: self.append_log(job,[redact(pending.decode(errors='replace'))])
        readers = [asyncio.create_task(read(process.stdout, 0)), asyncio.create_task(read(process.stderr, 1))]
        try:
            await asyncio.wait_for(asyncio.gather(*readers), timeout)
            code = await asyncio.wait_for(process.wait(), 3)
            stdout,stderr=(bytes(b).decode(errors='replace') for b in buffers)
            if code == 0 and sha256_fields:
                # Logs remain redacted. Preserve validated, non-secret machine digests
                # in structured results: a coincidental password substring is not a credential.
                def clean(value, key=None):
                    if isinstance(value,dict): return {k:clean(v,k) for k,v in value.items()}
                    if isinstance(value,list): return [clean(v) for v in value]
                    if isinstance(value,str):
                        if key in sha256_fields and re.fullmatch('[0-9a-f]{64}',value) and value!=password: return value
                        return redact(value)
                    return value
                stdout=json.dumps(clean(json.loads(stdout)))
            else: stdout=redact(stdout)
            return code,stdout,redact(stderr)
        finally:
            if process.returncode is None:
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                await process.wait()
            for reader in readers: reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)

    @asynccontextmanager
    async def session(self, job, trust, password):
        with tempfile.TemporaryDirectory(prefix='oc-management-') as directory:
            directory = Path(directory)
            sock = directory/'askpass.sock'
            async def answer(reader, writer):
                try:
                    if await asyncio.wait_for(reader.readline(), 3) == b'password\n':
                        writer.write(password.encode()+b'\n'); await writer.drain()
                finally:
                    writer.close(); await writer.wait_closed()
            server = await asyncio.start_unix_server(answer, path=str(sock))
            known = directory/'known_hosts'
            target = job['target']; host = target['address']
            if target['port'] != 22: host = f"[{host}]:{target['port']}"
            known.write_text(''.join(f"{host} {k['type']} {k['key']}\n" for k in trust['keys']))
            helper = directory/'askpass'
            helper.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(Path(__file__).with_name('ssh_askpass.py')))+' "$@"\n')
            helper.chmod(0o700)
            env = dict(os.environ, SSH_ASKPASS=str(helper), SSH_ASKPASS_REQUIRE='force', DISPLAY='openchicken:0',
                       OPENCHICKEN_ASKPASS_SOCKET=str(sock), LC_ALL='C')
            session = Session(self, job, password, directory, known, env)
            try: yield session
            finally:
                server.close(); await server.wait_closed()

    async def execute(self, job, trust, password, execute):
        namespace = 'servo_audit' if job['operation']=='joint_readback' else 'program_deployment' if job['operation'].startswith('program_') else 'policy_management'
        try:
            job.update(status='running', started_at=stamp()); self.save(job)
            async with self.session(job, trust, password) as session:
                await execute(job, session)
            job.setdefault('result', {})
            if job['status'] == 'running': job['status'] = 'completed'
            if job['status'] == 'completed': self.resolve(job)
        except asyncio.CancelledError:
            job.update(status='unknown', error='Host stopped; query actual state before another change.')
            raise
        except NativeFailure as error:
            job.update(status='unknown' if job.get('mutation_started') and job.get('config_result') == 'unknown' else 'failed',
                       error=str(error).replace(password, '[redacted]'))
        except Exception as error:
            job.update(status='unknown' if job.get('mutation_started') else 'failed',
                       error=(str(error) or type(error).__name__).replace(password, '[redacted]'))
        finally:
            job['finished_at'] = stamp()
            self.save(job)
            self.registry.record_management(job['profile_id'], namespace, {'latest_job': job['id']},
                {k:copy.deepcopy(job[k]) for k in ('id', 'operation', 'detail', 'status', 'created_at', 'finished_at', 'config_result', 'load_result', 'motion_test')})
            self.checks.active.discard(job['profile_id'])

    async def close(self, app):
        for task in list(self.tasks): task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)


class Session:
    def __init__(self, jobs, job, password, directory, known, env):
        self.jobs, self.job, self.password, self.directory, self.known, self.env = jobs, job, password, directory, known, env

    def options(self):
        return ['-F', '/dev/null', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile='+str(self.known),
                '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UpdateHostKeys=no', '-o', 'ClearAllForwardings=yes',
                '-o', 'PermitLocalCommand=no', '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no',
                '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2']

    async def ssh(self, args, json_output=False, timeout=60, sha256_fields=()):
        target = self.job['target']
        argv = ['/usr/bin/ssh', *self.options(), '-T', '-a', '-x', '-p', str(target['port']), '-l', self.job['settings']['admin_user'] if self.job['operation'] in ('configd_apply','joint_readback') else target['user'],
                target['address'], shlex.join(map(str, args))]
        options={'sha256_fields':sha256_fields} if sha256_fields else {}
        code, stdout, stderr = await self.jobs.process(argv, timeout, self.job, self.password, self.env, **options)
        if code == 255: raise ConnectionError('SSH transport failed: '+(stderr or stdout)[-4000:])
        if code: raise NativeFailure(f'Native command exit {code}: '+(stderr or stdout)[-4000:])
        return json.loads(stdout) if json_output else stdout

    async def scp(self, source, remote):
        target = self.job['target']
        argv = ['/usr/bin/scp', *self.options(), '-P', str(target['port']), str(source),
                f"{target['user']}@{target['address']}:{absolute(remote)}"]
        code, stdout, stderr = await self.jobs.process(argv, 180, self.job, self.password, self.env)
        if code: raise NativeFailure('Upload failed: '+(stderr or stdout)[-3000:])
