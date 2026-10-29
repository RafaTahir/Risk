"""Build an original low-poly artillery barrel in Blender for the tabletop."""
import bpy, json, math
from pathlib import Path
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
# Four rings create a tapered breech, barrel and raised muzzle band. Z is up,
# Y points down the barrel, matching the existing carriage's local coordinates.
rings=[(-9,10.0,3.5),(-5,10.7,3.3),(7,13.2,2.8),(10,13.8,3.4),(11,14.0,3.4)]
sides=10
vertices=[(radius*math.cos(2*math.pi*i/sides),y,z+radius*math.sin(2*math.pi*i/sides)) for y,z,radius in rings for i in range(sides)]
faces=[]
for ring in range(len(rings)-1):
 for i in range(sides):
  a=ring*sides+i; b=ring*sides+(i+1)%sides; c=(ring+1)*sides+(i+1)%sides; d=(ring+1)*sides+i
  faces.extend([(a,c,b),(a,d,c)])
faces.extend([(0,i,i+1) for i in range(1,sides-1)])
last=(len(rings)-1)*sides
# An inset bore is part of the mesh, not a painted-on hole.
for y,z in [(11,14.0),(8.8,13.55)]:
 vertices.extend([(1.65*math.cos(2*math.pi*i/sides),y,z+1.65*math.sin(2*math.pi*i/sides)) for i in range(sides)])
rim=len(rings)*sides;deep=rim+sides
for i in range(sides):
 j=(i+1)%sides
 faces.extend([(last+i,rim+j,last+j),(last+i,rim+i,rim+j)])
 faces.extend([(rim+i,deep+j,rim+j),(rim+i,deep+i,deep+j)])
faces.extend([(deep,deep+i+1,deep+i) for i in range(1,sides-1)])
mesh=bpy.data.meshes.new('Artillery barrel');mesh.from_pydata(vertices,[],faces);mesh.update()
obj=bpy.data.objects.new('Artillery barrel',mesh);bpy.context.collection.objects.link(obj)
output=Path(__file__).resolve().parents[2]/'src/assets/cannon-barrel.json'
output.write_text(json.dumps({'positions':[round(c,5) for v in mesh.vertices for c in v.co],'indices':[i for face in mesh.polygons for i in face.vertices]},separators=(',',':'))+'\n')
print('Created original artillery barrel:',output,'vertices:',len(mesh.vertices),'triangles:',len(mesh.polygons))

source = Path(__file__).resolve().parent / 'source' / 'cannon_barrel.blend'
source.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(source), compress=True)
