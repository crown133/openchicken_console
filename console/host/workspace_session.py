"""Per-window monitor/commissioning permissions; telemetry stays subscribed."""


class WorkspaceSession:
    def __init__(self, console, owner, leases, mode='monitor'):
        self.console, self.owner, self.leases = console, owner, leases
        self.mode = mode if mode in ('monitor', 'commissioning') else 'commissioning'
        self.robot_id = None
        self.connection = None

    def detach(self):
        if self.connection:
            self.connection.control_users.discard(self.owner)
            if not self.connection.control_users:
                self.connection.close_control()
            self.connection = None

    async def select(self, mode, robot_id):
        if not isinstance(robot_id, str):
            raise ValueError('Select a robot')
        if mode not in ('monitor', 'commissioning'):
            raise ValueError('Unknown workspace mode')
        if mode != self.mode or robot_id != self.robot_id:
            for identity in list(self.leases):
                if mode == 'commissioning':
                    # Only this window's ownership can authorize a mode-transition relax.
                    import time
                    await self.console.command(self.owner, dict(type='relax', robot_id=identity,
                                                               sent_at=time.time()*1000), self.leases)
                else:
                    await self.console.release(self.owner, identity, self.leases)
            self.detach()
        self.mode, self.robot_id = mode, robot_id
        conn = self.console.connections.get(robot_id)
        if mode == 'monitor' and conn and not conn.readonly:
            conn.control_users.add(self.owner)
            conn.open_control()
            self.connection = conn
        return dict(mode=self.mode, robot_id=self.robot_id)

    async def command(self, message):
        if message.get('type') == 'pwm':
            if self.mode != 'commissioning':
                raise ValueError('PWM calibration is only available in Commissioning')
            robot_id = message.get('robot_id')
            if not self.robot_id or robot_id != self.robot_id:
                raise ValueError('Select this robot before calibrating it')
            conn = self.console.connections.get(robot_id)
            if conn is None or conn.readonly:
                raise ValueError('PWM calibration connection is not configured')
            if self.connection is None:
                conn.control_users.add(self.owner)
                conn.open_control()
                self.connection = conn
            return await self.console.command(self.owner, message, self.leases)
        if self.mode != 'monitor':
            raise ValueError('Commissioning is read-only; switch to Monitor for control')
        robot_id = message.get('robot_id')
        if self.robot_id is not None and robot_id != self.robot_id:
            if message.get('type') == 'claim':
                await self.select('monitor', robot_id)
            else:
                raise ValueError('Select this robot before controlling it')
        if self.connection is None:
            await self.select('monitor', robot_id)
        return await self.console.command(self.owner, message, self.leases)

    def frame(self):
        frame = self.console.frame(self.owner)
        frame['mode'] = self.mode
        if self.mode == 'commissioning':
            frame['robots'] = [dict(r, capabilities=dict(motion=False, init=False, relax=False,
                                                        estop=False, skills=[], pwm=bool(r.get('capabilities', {}).get('pwm')))) for r in frame['robots']]
        return frame
