"""Convert the existing upstream baked mesh to URDF/STL, without changing calibration.

Layout is defined by openchicken_deploy/scripts/bake-openchicken-mesh.py, format v1.
This is a derived display model, not a validated mechanical calibration.
"""
import hashlib
import json
import math
from pathlib import Path
import struct
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent/'openchicken_deploy'
NAMES = ['left_hip_yaw','left_hip_roll','left_hip_pitch','left_knee','left_ankle',
         'neck_pitch','head_pitch','head_yaw','head_roll','mouth',
         'right_hip_yaw','right_hip_roll','right_hip_pitch','right_knee','right_ankle']


def rpy(quaternion):
    norm = math.sqrt(sum(x*x for x in quaternion))
    w, x, y, z = [v/norm for v in quaternion]
    r00, r10, r20 = 1-2*(y*y+z*z), 2*(x*y+w*z), 2*(x*z-w*y)
    cos_pitch = math.hypot(r00, r10)
    pitch = math.atan2(-r20, cos_pitch)
    if cos_pitch < 1e-8:
        # At ±90° roll and yaw are coupled. Choose roll=0 while preserving the
        # matrix; independent atan2(0, 0) calls otherwise rotate assembled parts.
        return (0.0, pitch, math.atan2(-2*(x*y-w*z), 1-2*(x*x+z*z)))
    return (math.atan2(2*(y*z+w*x), 1-2*(x*x+y*y)), pitch, math.atan2(r10, r00))


def vector(values):
    return ' '.join(f'{v:.10g}' for v in values)


def build():
    data = (SOURCE/'robotctl/assets/duck.bin').read_bytes()
    offset = 0
    def read(fmt):
        nonlocal offset
        result = struct.unpack_from('<'+fmt, data, offset)
        offset += struct.calcsize('<'+fmt)
        return result
    magic, version, nm, nb, np = read('4sIHHH')
    assert magic == b'DUCK' and version == 1
    out = ROOT/'models'/'alpha'
    (out/'meshes').mkdir(parents=True, exist_ok=True)
    for index in range(nm):
        nv, nt = read('HH')
        vertices = [read('3f') for _ in range(nv)]
        faces = [read('3H') for _ in range(nt)]
        stl = bytearray(b'Microduck derived simplified mesh'.ljust(80, b'\0'))
        stl += struct.pack('<I', nt)
        for face in faces:
            stl += struct.pack('<12fH', 0, 0, 0, *(v for i in face for v in vertices[i]), 0)
        (out/'meshes'/f'{index}.stl').write_bytes(stl)
    bodies = []
    for _ in range(nb):
        parent, joint = read('hh')
        bodies.append(dict(parent=parent, joint=joint, pos=read('3f'), quat=read('4f'), axis=read('3f')))
    parts = []
    for _ in range(np):
        body, mesh, red, green, blue, _pad = read('HHBBBB')
        parts.append(dict(body=body, mesh=mesh, rgba=(red/255,green/255,blue/255,1), pos=read('3f'), quat=read('4f')))
    assert offset == len(data)
    xml = ET.parse(SOURCE/'kinematics/assets/alpha/robot_walk.xml')
    ranges = {j.get('name'): j.get('range').split() for j in xml.iter('joint')}
    root = ET.Element('robot', name='microduck_alpha_simplified')
    ET.SubElement(root, 'link', name='world')
    mapping = {}
    for index, body in enumerate(bodies):
        name = f'body_{index}'
        link = ET.SubElement(root, 'link', name=name)
        for part in (p for p in parts if p['body'] == index):
            visual = ET.SubElement(link, 'visual')
            ET.SubElement(visual, 'origin', xyz=vector(part['pos']), rpy=vector(rpy(part['quat'])))
            geom = ET.SubElement(visual, 'geometry')
            ET.SubElement(geom, 'mesh', filename=f'meshes/{part["mesh"]}.stl')
            material = ET.SubElement(visual, 'material', name=f'part_{index}_{part["mesh"]}')
            ET.SubElement(material, 'color', rgba=vector(part['rgba']))
        joint_name = NAMES[body['joint']] if body['joint'] >= 0 else f'fixed_{index}'
        joint = ET.SubElement(root, 'joint', name=joint_name, type='revolute' if body['joint'] >= 0 else 'fixed')
        ET.SubElement(joint, 'parent', link=f'body_{body["parent"]}' if body['parent'] >= 0 else 'world')
        ET.SubElement(joint, 'child', link=name)
        ET.SubElement(joint, 'origin', xyz=vector(body['pos']), rpy=vector(rpy(body['quat'])))
        if body['joint'] >= 0:
            ET.SubElement(joint, 'axis', xyz=vector(body['axis']))
            low, high = ranges[joint_name]
            ET.SubElement(joint, 'limit', lower=low, upper=high, effort='1', velocity='1')
            mapping[joint_name] = dict(link=name, direction=1, model_offset=0, verified=False)
    ET.indent(root)
    ET.ElementTree(root).write(out/'robot.urdf', encoding='utf-8', xml_declaration=True)
    provenance = dict(source='Existing local upstream assets; no new model download',
                      source_commit='942e58e3aa6dbb28e7037203fff11866122c7567',
                      source_path=str(SOURCE/'robotctl/assets/duck.bin'),
                      source_sha256=hashlib.sha256(data).hexdigest(), meshes=nm, bodies=nb, parts=np,
                      model_verified=False, joints=mapping,
                      note='Simplified official visual model. Physical ID mapping, axis and zero require verification. Homing Offset is not reapplied.')
    (out/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
    (out/'LICENSE.microduck').write_bytes((SOURCE/'LICENSE').read_bytes())
    print(f'Converted {nm} meshes, {nb} bodies, {np} parts, {len(mapping)} movable joints')


if __name__ == '__main__':
    build()
