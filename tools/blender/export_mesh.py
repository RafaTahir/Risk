"""Export a named mesh from an edited .blend as the runtime's triangle JSON.

Example: blender -b tools/blender/source/cannon_barrel.blend --python
  tools/blender/export_mesh.py -- 'Artillery barrel' src/assets/cannon-barrel.json
"""
import bpy, json, sys
from pathlib import Path
if '--' not in sys.argv or len(sys.argv[sys.argv.index('--') + 1:]) != 2:
    raise SystemExit('Pass -- followed by an object name and output JSON path')
name, output = sys.argv[sys.argv.index('--') + 1:]
obj = bpy.data.objects.get(name)
if not obj or obj.type != 'MESH':
    raise SystemExit(f'Mesh object not found: {name}')
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    mesh.calc_loop_triangles()
    positions = [round(c, 5) for vertex in mesh.vertices for c in (evaluated.matrix_world @ vertex.co)]
    indices = [index for triangle in mesh.loop_triangles for index in triangle.vertices]
    Path(output).write_text(json.dumps({'positions': positions, 'indices': indices}, separators=(',', ':')) + '\n')
    print('Exported', name, 'vertices:', len(mesh.vertices), 'triangles:', len(mesh.loop_triangles))
finally:
    evaluated.to_mesh_clear()
