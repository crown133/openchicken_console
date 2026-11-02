"""Compare generated URDF to independent quaternion transforms in the source asset."""
import math
from pathlib import Path
import struct
import sys
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.build_model import NAMES, rpy
from protocol.model import JOINTS

ROOT = Path(__file__).resolve().parents[1]


def multiply(a, b):
    return [[sum(a[i][k]*b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]

def quaternion_transform(q, pos=(0, 0, 0)):
    n = math.sqrt(sum(v*v for v in q))
    w, x, y, z = [v/n for v in q]
    return [[1-2*(y*y+z*z), 2*(x*y-w*z), 2*(x*z+w*y), pos[0]],
            [2*(x*y+w*z), 1-2*(x*x+z*z), 2*(y*z-w*x), pos[1]],
            [2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y), pos[2]],
            [0, 0, 0, 1]]

def urdf_transform(node):
    roll, pitch, yaw = [float(v) for v in node.get('rpy', '0 0 0').split()]
    result = quaternion_transform((1, 0, 0, 0), [float(v) for v in node.get('xyz', '0 0 0').split()])
    for axis, angle in [((0, 0, 1), yaw), ((0, 1, 0), pitch), ((1, 0, 0), roll)]:
        s = math.sin(angle/2)
        result = multiply(result, quaternion_transform((math.cos(angle/2), *(s*v for v in axis))))
    return result

def baked_transforms():
    data = (ROOT.parent/'openchicken_deploy/robotctl/assets/duck.bin').read_bytes()
    _, _, meshes, bodies, parts = struct.unpack_from('<4sIHHH', data)
    offset = 14
    for _ in range(meshes):
        nv, nt = struct.unpack_from('<HH', data, offset)
        offset += 4 + nv*12 + nt*6
    body_rows, part_rows = [], []
    for _ in range(bodies):
        parent, joint, *values = struct.unpack_from('<hh10f', data, offset)
        body_rows.append((parent, joint, values[:3], values[3:7], values[7:]))
        offset += 44
    for _ in range(parts):
        body, mesh, *values = struct.unpack_from('<HH4B7f', data, offset)
        part_rows.append((body, mesh, values[4:7], values[7:]))
        offset += 36
    assert offset == len(data)
    return body_rows, part_rows


def reference_poses():
    """Independent MJCF quaternion FK, also consumed by the browser loader test."""
    source = ET.parse(ROOT/'models/alpha-full/source.mjcf.xml').getroot()
    bodies = list(source.find('worldbody').iter('body'))
    indices = {id(body): i for i, body in enumerate(bodies)}
    parents = {id(child): indices[id(body)] for body in bodies for child in body.findall('body')}
    zero = {name: 0 for _, name, _, _ in JOINTS}
    cases = [('zero', zero), ('home', {name: home for _, name, _, home in JOINTS})]
    cases += [(f'{name}:{angle}', dict(zero, **{name: angle})) for name in zero for angle in (-0.3, 0.3)]
    poses = []
    for name, angles in cases:
        world, matrices, part = [], {}, 0
        for index, body in enumerate(bodies):
            pos = [float(v) for v in body.get('pos', '0 0 0').split()]
            quat = [float(v) for v in body.get('quat', '1 0 0 0').split()]
            matrix = quaternion_transform(quat, pos)
            joint = body.find('joint')
            if joint is not None:
                axis = [float(v) for v in joint.get('axis').split()]
                angle = angles[joint.get('name')]
                matrix = multiply(matrix, quaternion_transform((math.cos(angle/2), *(v*math.sin(angle/2) for v in axis))))
            parent = parents.get(id(body), -1)
            if parent>=0: matrix = multiply(world[parent], matrix)
            world.append(matrix)
            matrices[f'body_{index}'] = matrix
            for geom in body.findall('geom'):
                if geom.get('class') != 'visual': continue
                gpos = [float(v) for v in geom.get('pos', '0 0 0').split()]
                gquat = [float(v) for v in geom.get('quat', '1 0 0 0').split()]
                matrices[f'visual_{part}_{geom.get("mesh")}'] = multiply(matrix, quaternion_transform(gquat, gpos))
                part += 1
        poses.append(dict(name=name, angles=angles, matrices=matrices))
    return poses


class ModelTransformTests(unittest.TestCase):
    def assertTransform(self, left, right, tolerance=2e-7):
        self.assertLess(max(abs(left[i][j]-right[i][j]) for i in range(4) for j in range(4)), tolerance)

    def test_gimbal_lock_keeps_original_rotation(self):
        for q in [(0.5, 0.5, 0.5, -0.5), (0.5, -0.5, -0.5, -0.5),
                  (0, 0.707107, 0, 0.707107)]:
            with self.subTest(quaternion=q):
                node = ET.Element('origin', rpy=' '.join(str(v) for v in rpy(q)))
                self.assertTransform(quaternion_transform(q), urdf_transform(node))

    def test_every_visual_origin_matches_original_quaternion(self):
        root = ET.parse(ROOT/'models/alpha/robot.urdf').getroot()
        _, parts = baked_transforms()
        for index, (part, visual) in enumerate(zip(parts, root.findall('.//visual'), strict=True)):
            _, _, pos, q = part
            with self.subTest(part=index):
                self.assertTransform(quaternion_transform(q, pos), urdf_transform(visual.find('origin')))

    def test_all_link_poses_and_parentage_match_mjcf(self):
        source = ET.parse(ROOT.parent/'openchicken_deploy/kinematics/assets/alpha/robot_walk.xml').getroot()
        urdf = ET.parse(ROOT/'models/alpha/robot.urdf').getroot()
        joints = {j.find('child').get('link'): j for j in urdf.findall('joint')}
        bodies = list(source.iter('body'))
        indices = {id(body): index for index, body in enumerate(bodies)}
        parents = {id(child): indices[id(body)] for body in bodies for child in body.findall('body')}
        # Exercise each joint independently: an incorrect parent must affect the wrong subtree.
        for active in [None] + NAMES:
            expected, actual = [], []
            for index, body in enumerate(bodies):
                joint = joints[f'body_{index}']
                parent = parents.get(id(body), -1)
                self.assertEqual(joint.find('parent').get('link'), 'world' if parent<0 else f'body_{parent}')
                mj_joint = body.find('joint')
                if mj_joint is not None:
                    self.assertEqual(joint.get('name'), mj_joint.get('name'))
                    self.assertEqual(joint.find('axis').get('xyz'), mj_joint.get('axis'))
                pos = [float(v) for v in body.get('pos', '0 0 0').split()]
                q = [float(v) for v in body.get('quat', '1 0 0 0').split()]
                angle = .3 if joint.get('name')==active else 0
                spin = quaternion_transform((math.cos(angle/2), 0, 0, math.sin(angle/2)))
                e = multiply(quaternion_transform(q, pos), spin)
                a = multiply(urdf_transform(joint.find('origin')), spin)
                if parent>=0:
                    e, a = multiply(expected[parent], e), multiply(actual[parent], a)
                expected.append(e); actual.append(a)
                with self.subTest(active=active, link=index): self.assertTransform(e, a)

    def test_full_model_world_transforms_in_30_poses(self):
        root = ET.parse(ROOT/'models/alpha-full/robot.urdf').getroot()
        links = {link.get('name'): link for link in root.findall('link')}
        self.assertEqual(len(root.findall('.//visual')), 64)
        for case in reference_poses():
            world = {'world': quaternion_transform((1, 0, 0, 0))}
            for joint in root.findall('joint'):
                child, parent = joint.find('child').get('link'), joint.find('parent').get('link')
                matrix = urdf_transform(joint.find('origin'))
                if joint.get('type') != 'fixed':
                    axis = [float(v) for v in joint.find('axis').get('xyz').split()]
                    angle = case['angles'][joint.get('name')]
                    matrix = multiply(matrix, quaternion_transform((math.cos(angle/2), *(v*math.sin(angle/2) for v in axis))))
                world[child] = multiply(world[parent], matrix)
                self.assertTransform(world[child], case['matrices'][child])
                for visual in links[child].findall('visual'):
                    actual = multiply(world[child], urdf_transform(visual.find('origin')))
                    with self.subTest(pose=case['name'], visual=visual.get('name')):
                        self.assertTransform(actual, case['matrices'][visual.get('name')])

    def test_full_mesh_files_are_exact_approved_source(self):
        import hashlib
        import json
        folder = ROOT/'models/alpha-full'
        rows = json.loads((folder/'SOURCES.json').read_text())
        self.assertEqual(len(rows), 35)
        for row in rows:
            path = Path(row['destination'])
            local = folder/'source.mjcf.xml' if path.suffix=='.xml' else folder/'meshes'/path.name
            self.assertEqual(hashlib.sha256(local.read_bytes()).hexdigest(), row['sha256'])


if __name__ == '__main__':
    unittest.main()
