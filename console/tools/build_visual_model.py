"""Build a display-only URDF from the approved, pinned official full CAD assets.

No downloaded code is executed. MJCF is parsed only for body/joint/visual data;
actuator, sensor and simulation settings are not used by this Web model.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import xml.etree.ElementTree as ET

from build_model import ROOT, rpy, vector

COMMIT = '659429207558d69a6270560e33725b84f26a954e'


def numbers(node, key, default):
    return [float(v) for v in node.get(key, default).split()]


def origin(parent, node):
    ET.SubElement(parent, 'origin', xyz=vector(numbers(node, 'pos', '0 0 0')),
                  rpy=vector(rpy(numbers(node, 'quat', '1 0 0 0'))))


def build(source):
    out = ROOT/'models/alpha-full'
    out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((source/'manifest.json').read_text())
    for row in manifest:
        path = ROOT.parent/row['destination']
        assert f'/{COMMIT}/' in row['source_url']
        assert path.stat().st_size == row['size']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256']
    model = ET.parse(source/'robot_walk.xml').getroot()
    assert model.find('compiler').get('angle') == 'radian'
    materials = {m.get('name'): m.get('rgba') for m in model.findall('.//asset/material')}
    meshes = {m.get('name', Path(m.get('file')).stem): m for m in model.findall('.//asset/mesh')}
    bodies = list(model.find('worldbody').iter('body'))
    indices = {id(body): i for i, body in enumerate(bodies)}
    parents = {id(child): indices[id(body)] for body in bodies for child in body.findall('body')}
    root = ET.Element('robot', name='microduck_alpha_full')
    ET.SubElement(root, 'link', name='world')
    mapping, parts, triangles = {}, 0, 0
    for index, body in enumerate(bodies):
        link_name = f'body_{index}'
        link = ET.SubElement(root, 'link', name=link_name)
        for geom in body.findall('geom'):
            if geom.get('class') != 'visual':
                continue
            assert geom.get('mesh') in meshes
            mesh = meshes[geom.get('mesh')]
            visual = ET.SubElement(link, 'visual', name=f'visual_{parts}_{geom.get("mesh")}')
            origin(visual, geom)
            geometry = ET.SubElement(visual, 'geometry')
            ET.SubElement(geometry, 'mesh', filename='meshes/'+mesh.get('file'), scale=mesh.get('scale', '1 1 1'))
            rgba = geom.get('rgba', materials.get(geom.get('material'), '0.6 0.6 0.6 1'))
            material = ET.SubElement(visual, 'material', name=f'visual_material_{parts}')
            ET.SubElement(material, 'color', rgba=rgba)
            parts += 1
            data = (source/'assets'/mesh.get('file')).read_bytes()
            triangles += struct.unpack_from('<I', data, 80)[0]
        hinge = body.find('joint')
        parent = parents.get(id(body), -1)
        joint = ET.SubElement(root, 'joint', name=hinge.get('name') if hinge is not None else f'fixed_{index}',
                              type='revolute' if hinge is not None else 'fixed')
        ET.SubElement(joint, 'parent', link='world' if parent<0 else f'body_{parent}')
        ET.SubElement(joint, 'child', link=link_name)
        origin(joint, body)
        if hinge is not None:
            assert hinge.get('type', 'hinge') == 'hinge'
            assert numbers(hinge, 'pos', '0 0 0') == [0, 0, 0]
            assert float(hinge.get('ref', '0')) == 0
            ET.SubElement(joint, 'axis', xyz=hinge.get('axis', '0 0 1'))
            low, high = hinge.get('range').split()
            # URDF requires effort/velocity; these placeholders are never used to control hardware.
            ET.SubElement(joint, 'limit', lower=low, upper=high, effort='1', velocity='1')
            mapping[hinge.get('name')] = dict(link=link_name, source_body=body.get('name'),
                                             direction=1, model_offset=0, verified=False)
    (out/'meshes').mkdir(exist_ok=True)
    for mesh in meshes.values():
        dest = out/'meshes'/mesh.get('file')
        src = source/'assets'/mesh.get('file')
        # Never replace a different downloaded asset on a rebuild.
        if dest.exists():
            assert dest.read_bytes() == src.read_bytes()
        else:
            with dest.open('xb') as file:
                file.write(src.read_bytes())
    ET.indent(root)
    ET.ElementTree(root).write(out/'robot.urdf', encoding='utf-8', xml_declaration=True)
    shutil.copyfile(source/'robot_walk.xml', out/'source.mjcf.xml')
    shutil.copyfile(source/'manifest.json', out/'SOURCES.json')
    provenance = dict(model_id='alpha-full-65942920', source='pollen-robotics/microduck_rl', source_commit=COMMIT,
                      source_url=f'https://github.com/pollen-robotics/microduck_rl/tree/{COMMIT}/src/mjlab_microduck/robot/microduck',
                      source_sha256=hashlib.sha256((source/'robot_walk.xml').read_bytes()).hexdigest(),
                      meshes=len(meshes), bodies=len(bodies), parts=parts, instanced_triangles=triangles,
                      quality='original STL, no decimation', model_verified=False, joints=mapping,
                      note='MJCF/URDF transforms verified separately. Physical servo direction and zero remain unverified. No homing offset reapplied.',
                      license_note='No LICENSE file found in the upstream repository tree at this commit; source attribution retained, no license inferred.')
    (out/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
    print(json.dumps({k:provenance[k] for k in ('meshes','bodies','parts','instanced_triangles')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Approved staging directory containing manifest.json')
    build(parser.parse_args().source)
