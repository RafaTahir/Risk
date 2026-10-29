"""Create a small original compass in Blender; export a lightweight triangle mesh."""
import bpy, json, math
from pathlib import Path
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
vertices=[(0,0,0)]
for i in range(16):
    angle=math.pi/2+i*math.pi/8
    radius=34 if i%4==0 else 12 if i%2==0 else 5
    vertices.append((radius*math.cos(angle),radius*math.sin(angle),0))
faces=[(0,i+1,(i+1)%16+1) for i in range(16)]
mesh=bpy.data.meshes.new('Compass rose'); mesh.from_pydata(vertices,[],faces); mesh.update()
obj=bpy.data.objects.new('Compass rose',mesh); bpy.context.collection.objects.link(obj)
output=Path(__file__).resolve().parents[2]/'src/assets/compass-rose.json'
output.write_text(json.dumps({'positions':[round(c,5) for v in mesh.vertices for c in v.co], 'indices':[i for face in mesh.polygons for i in face.vertices]},separators=(',',':'))+'\n')
print('Created original compass mesh:', output, 'vertices:',len(mesh.vertices),'triangles:',len(mesh.polygons))
