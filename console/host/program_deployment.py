"""Thin adapter to the deploy repository's versioned Radxa deployment script."""
import hashlib
import asyncio
import json
from pathlib import Path
import sys
import uuid
import time

from host.ssh_checks import private_json, stamp
from host.management_jobs import program_evidence


class ProgramDeployment:
    def __init__(self, jobs, console=None):
        self.jobs = jobs
        self.console = console
        self.path = jobs.root/'host-settings.json'

    def settings(self):
        return json.loads(self.path.read_text()) if self.path.exists() else {'deploy_repository': ''}

    def configure(self, body):
        if set(body) != {'deploy_repository'} or not isinstance(body['deploy_repository'], str):
            raise ValueError('Configure only the backend-local deploy repository path')
        path = Path(body['deploy_repository']).expanduser()
        if not path.is_absolute() or not (path/'deploy/radxa/deploy.py').is_file():
            raise ValueError('Repository must contain deploy/radxa/deploy.py')
        value = {'deploy_repository': str(path.resolve())}
        private_json(self.path, value)
        return value

    def script(self):
        root = self.settings()['deploy_repository']
        if not root: raise ValueError('Set the local deploy repository path first')
        script = Path(root)/'deploy/radxa/deploy.py'
        if not script.is_file(): raise ValueError('Deployment entry point not found')
        return script

    @staticmethod
    def result(stdout):
        values = [json.loads(line) for line in stdout.splitlines() if line.strip()]
        results = [v for v in values if isinstance(v, dict) and v.get('event') == 'result']
        if len(results) != 1: raise ValueError('Deployment script did not return one final result')
        return results[0]

    async def packages(self):
        # Local read-only listing does not require an SSH password.
        job = dict(id=uuid.uuid4().hex, profile_id='local', operation='program_list', status='running', log=[], created_at=stamp())
        try:
            code, stdout, stderr = await self.jobs.process([sys.executable, str(self.script()), 'list', '--json'], 30, job)
            result = self.result(stdout)
            if code or result.get('status') != 'success': raise ValueError(result.get('message') or result.get('error') or stderr or 'Package listing failed')
            job['status']='completed'
            return result
        finally:
            if job['status']=='running': job['status']='failed'
            job['finished_at']=stamp(); self.jobs.save(job)

    async def preview(self, identity, action, build_id=None):
        if action not in ('status', 'apply', 'rollback'): raise ValueError('Unknown deployment action')
        script = self.script()
        detail = dict(repository=str(script.parents[2]), script_sha256=hashlib.sha256(script.read_bytes()).hexdigest())
        if action == 'apply':
            packages = await self.packages()
            package = next((p for p in packages['packages'] if p['build_id'] == build_id), None)
            if not package: raise ValueError('Selected build is no longer available')
            detail['package'] = package
        return self.jobs.preview(identity, 'program_'+action, detail)

    async def execute(self, job, session):
        previous_program = program_evidence(self.jobs.row(job['profile_id']))
        script = self.script()
        detail = job['detail']; action = job['operation'].removeprefix('program_')
        if str(script.parents[2]) != detail['repository'] or hashlib.sha256(script.read_bytes()).hexdigest() != detail['script_sha256']:
            raise ValueError('Deployment script changed after preview')
        if action == 'apply':
            current = next((p for p in (await self.packages())['packages'] if p['build_id'] == detail['package']['build_id']), None)
            if current != detail['package']: raise ValueError('Deployment package changed after preview')
        config = job['settings']; target = job['target']
        target_file = session.directory/'target.json'
        private_json(target_file, dict(profile_id=job['profile_id'], host=target['address'], port=target['port'],
            ssh_user=config['admin_user'], deploy_root=config['deploy_root'], robot_socket=config['robot_socket'], known_hosts_file=str(session.known)))
        args = [sys.executable, str(script), action, '--target-file', str(target_file), '--json']
        if action == 'apply': args += ['--build-id', detail['package']['build_id']]
        job['mutation_started'] = action != 'status'
        self.jobs.registry.record_management(job['profile_id'], 'program_deployment',
            {'telemetry':dict(status='not_checked', job_id=job['id'], target=target, queried_at=stamp())})
        if job['mutation_started']:
            self.jobs.registry.record_management(job['profile_id'], 'policy_management', {'bindings':{}})
            self.jobs.registry.record_management(job['profile_id'], 'program_deployment',
                {'last_change':dict(result={'status':'unknown'}, queried_at=stamp(), job_id=job['id'], target=target, settings=config)})
        self.jobs.save(job)
        connection = self.connection(job)
        previous_boot = (connection.state or {}).get('boot_id') if connection else None
        code, stdout, stderr = await self.jobs.process(args, 900 if action != 'status' else 60, job, session.password, session.env)
        result = self.result(stdout)
        job['result'] = result
        status = result.get('status')
        job['status'] = 'completed' if code == 0 and status == 'success' else 'unknown' if status == 'unknown' or code == 2 else 'failed'
        job['config_result'] = 'not_applicable' if action == 'status' else 'confirmed' if job['status'] == 'completed' else 'unknown'
        job['load_result'] = 'not_applicable'
        # The native result is the evidence; successful upload alone is never a deployment result.
        self.jobs.registry.record_management(job['profile_id'], 'program_deployment',
            {'last_query' if action == 'status' else 'last_change': dict(result=result, queried_at=stamp(), job_id=job['id'], target=target, settings=config)})
        if previous_program != program_evidence(self.jobs.row(job['profile_id'])):
            self.jobs.registry.record_management(job['profile_id'], 'policy_management', {'bindings':{}})
        if job['status'] == 'completed':
            job['telemetry'] = await self.telemetry(job, previous_boot)
            job['telemetry']['job_id'] = job['id']
            self.jobs.registry.record_management(job['profile_id'], 'program_deployment', {'telemetry':job['telemetry']})

    def connection(self, job):
        if self.console is None: return None
        row = self.jobs.row(job['profile_id'])
        conn = self.console.connections.get(row['robot_id'])
        expected = f"tcp://{row['address']}:{row['state_port']}"
        return conn if conn and conn.source == 'robot' and (conn.config or {}).get('endpoint') == expected else None

    async def telemetry(self, job, previous_boot):
        started = time.monotonic()
        while time.monotonic()-started < 10:
            conn = self.connection(job)
            if conn is None: return dict(status='not_connected', queried_at=stamp(), target=job['target'])
            state = conn.state or {}
            fresh = conn.received_at > started and time.monotonic()-conn.received_at < conn.timeout
            restarted = job['operation'] == 'program_status' or state.get('boot_id') != previous_boot
            if fresh and restarted and state.get('boot_id'):
                return dict(status='confirmed', boot_id=state['boot_id'], seq=state.get('seq'), queried_at=stamp(), target=job['target'])
            await asyncio.sleep(.1)
        return dict(status='timeout', queried_at=stamp(), target=job['target'])
