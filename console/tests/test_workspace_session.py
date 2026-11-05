"""Mode changes use fake connections; no robot or native service is contacted."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from host.workspace_session import WorkspaceSession


class WorkspaceTests(unittest.IsolatedAsyncioTestCase):
    def setup_console(self):
        connection = SimpleNamespace(readonly=False, control_users=set(), open_control=Mock(), close_control=Mock())
        console = SimpleNamespace(connections={'robot':connection}, command=AsyncMock(return_value={'accepted':True}), release=AsyncMock(), frame=Mock(return_value={'robots':[{'robot_id':'robot','online':True,'capabilities':{'motion':True}}]}))
        return console, connection

    async def test_connecting_monitor_never_claims_or_enables(self):
        console, conn = self.setup_console()
        session = WorkspaceSession(console, 'window', {}, 'commissioning')
        await session.select('monitor', 'robot')
        conn.open_control.assert_called_once()
        console.command.assert_not_called()
        self.assertEqual(conn.control_users, {'window'})

    async def test_commissioning_rejects_commands_and_masks_capabilities(self):
        console, conn = self.setup_console()
        session = WorkspaceSession(console, 'window', {}, 'commissioning')
        await session.select('commissioning', 'robot')
        for kind in ('claim', 'init', 'drive', 'relax', 'pad_command'):
            with self.assertRaisesRegex(ValueError, 'read-only'):
                await session.command({'type':kind,'robot_id':'robot'})
        self.assertFalse(session.frame()['robots'][0]['capabilities']['motion'])
        self.assertTrue(session.frame()['robots'][0]['online'])
        console.command.assert_not_called()
        conn.open_control.assert_not_called()

    async def test_switch_relaxes_only_owned_robot_before_detaching(self):
        console, conn = self.setup_console()
        leases={'robot':{}}
        session=WorkspaceSession(console,'one',leases)
        await session.select('monitor','robot')
        console.command.reset_mock()
        await session.select('commissioning','robot')
        self.assertEqual(console.command.call_args.args[1]['type'],'relax')
        conn.close_control.assert_called_once()
        self.assertEqual(session.mode,'commissioning')

    async def test_failed_relax_does_not_pretend_switch_succeeded(self):
        console, conn = self.setup_console()
        session=WorkspaceSession(console,'one',{})
        await session.select('monitor','robot');session.leases['robot']={}
        console.command.side_effect=ValueError('not confirmed')
        with self.assertRaisesRegex(ValueError,'not confirmed'):
            await session.select('commissioning','robot')
        self.assertEqual(session.mode,'monitor')
        conn.close_control.assert_not_called()

    async def test_other_monitor_window_keeps_its_channel(self):
        console, conn = self.setup_console()
        a,b=WorkspaceSession(console,'a',{}),WorkspaceSession(console,'b',{})
        await a.select('monitor','robot');await b.select('monitor','robot')
        await a.select('commissioning','robot')
        self.assertEqual(conn.control_users,{'b'})
        conn.close_control.assert_not_called()
        console.command.assert_not_called()
        b.detach();conn.close_control.assert_called_once()

    async def test_cannot_control_unselected_robot(self):
        console,conn=self.setup_console()
        session=WorkspaceSession(console,'one',{})
        await session.select('monitor','robot')
        with self.assertRaisesRegex(ValueError,'Select'):
            await session.command({'type':'init','robot_id':'other'})
        console.command.assert_not_called()

    async def test_readonly_robot_stays_readonly_in_monitor(self):
        console,conn=self.setup_console();conn.readonly=True
        session=WorkspaceSession(console,'one',{})
        await session.select('monitor','robot')
        conn.open_control.assert_not_called()

    async def test_pwm_only_in_commissioning_for_selected_robot(self):
        console, conn = self.setup_console()
        session = WorkspaceSession(console, 'window', {}, 'commissioning')
        await session.select('commissioning', 'robot')
        conn.open_control.assert_not_called()
        for action in ('enable', 'update', 'disable'):
            message = {'type':'pwm', 'robot_id':'robot', 'payload':{'action':action}}
            await session.command(message)
            self.assertEqual(console.command.call_args.args[1], message)
        conn.open_control.assert_called_once()
        self.assertEqual(conn.control_users, {'window'})
        for kind in ('claim', 'init', 'drive', 'pad_input', 'pad_command'):
            with self.assertRaisesRegex(ValueError, 'read-only'):
                await session.command({'type':kind, 'robot_id':'robot'})
        with self.assertRaisesRegex(ValueError, 'Select'):
            await session.command({'type':'pwm', 'robot_id':'other'})
        await session.select('monitor', 'robot')
        with self.assertRaisesRegex(ValueError, 'only available'):
            await session.command({'type':'pwm', 'robot_id':'robot'})

    async def test_pwm_capability_and_readonly_connection(self):
        console, conn = self.setup_console()
        console.frame.return_value['robots'][0]['capabilities']['pwm'] = True
        session = WorkspaceSession(console, 'window', {}, 'commissioning')
        await session.select('commissioning', 'robot')
        self.assertTrue(session.frame()['robots'][0]['capabilities']['pwm'])
        self.assertFalse(session.frame()['robots'][0]['capabilities']['motion'])
        conn.readonly = True
        with self.assertRaisesRegex(ValueError, 'not configured'):
            await session.command({'type':'pwm', 'robot_id':'robot'})
        console.command.assert_not_called()
        conn.open_control.assert_not_called()
