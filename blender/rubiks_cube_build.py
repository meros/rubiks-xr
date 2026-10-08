# Builds the Rubik's cube scene: materials, desk scene, bone rig, demo animation.
import bpy, bmesh, math, os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- reset -----------------------------------------------------------------
for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.lights,
             bpy.data.cameras, bpy.data.armatures, bpy.data.actions):
    for d in list(coll):
        coll.remove(d)
for c in list(bpy.data.collections):
    bpy.data.collections.remove(c)
scene = bpy.context.scene
root_coll = scene.collection

def coll(name, parent=root_coll):
    c = bpy.data.collections.new(name); parent.children.link(c); return c
C_CUBE, C_SET, C_RIG, C_WGT = coll("Cube"), coll("Set"), coll("Rig"), coll("Widgets")
C_WGT.hide_viewport = C_WGT.hide_render = True

def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

def link(nt, a, b): nt.links.new(a, b)

def set_in(node, name, val):
    if name in node.inputs: node.inputs[name].default_value = val

# ---- materials -------------------------------------------------------------
def plastic(name, rgb, rough, coat=0.0, bump=0.02, rough_var=0.08):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; n = nt.nodes
    bsdf = n["Principled BSDF"]
    set_in(bsdf, "Base Color", (*rgb, 1))
    set_in(bsdf, "Coat Weight", coat); set_in(bsdf, "Coat Roughness", 0.08)
    set_in(bsdf, "Specular IOR Level", 0.5)
    tc = n.new("ShaderNodeTexCoord")
    noise = n.new("ShaderNodeTexNoise"); set_in(noise, "Scale", 60.0); set_in(noise, "Detail", 6.0)
    link(nt, tc.outputs["Object"], noise.inputs["Vector"])
    mr = n.new("ShaderNodeMapRange")
    set_in(mr, "To Min", rough - rough_var); set_in(mr, "To Max", rough + rough_var)
    link(nt, noise.outputs["Fac"], mr.inputs["Value"]); link(nt, mr.outputs["Result"], bsdf.inputs["Roughness"])
    bp = n.new("ShaderNodeBump"); set_in(bp, "Strength", bump); set_in(bp, "Distance", 0.002)
    link(nt, noise.outputs["Fac"], bp.inputs["Height"]); link(nt, bp.outputs["Normal"], bsdf.inputs["Normal"])
    return m

M_BODY = plastic("Plastic_Black", (0.008, 0.008, 0.009), 0.38, coat=0.0, bump=0.03)
# Official-style sticker colours (sRGB hex) with a light clear coat.
STICKERS = {
    (0, 0, 1):  ("White",  "#F4F4F2"),
    (0, 0, -1): ("Yellow", "#FFD500"),
    (0, -1, 0): ("Green",  "#009B48"),
    (0, 1, 0):  ("Blue",   "#0046AD"),
    (1, 0, 0):  ("Red",    "#B71234"),
    (-1, 0, 0): ("Orange", "#FF5800"),
}
M_ST = {n: plastic("Sticker_" + nm, srgb(hx), 0.18, coat=0.35, bump=0.015, rough_var=0.05)
        for n, (nm, hx) in STICKERS.items()}

def wood():
    m = bpy.data.materials.new("Wood_Oak"); m.use_nodes = True
    nt = m.node_tree; n = nt.nodes; bsdf = n["Principled BSDF"]
    tc = n.new("ShaderNodeTexCoord"); mp = n.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (0.06, 0.3, 1.0)
    link(nt, tc.outputs["Object"], mp.inputs["Vector"])
    wave = n.new("ShaderNodeTexWave"); wave.wave_type = 'RINGS'
    set_in(wave, "Scale", 1.2); set_in(wave, "Distortion", 14.0); set_in(wave, "Detail", 4.0)
    set_in(wave, "Detail Scale", 2.5)
    grain = n.new("ShaderNodeTexNoise"); set_in(grain, "Scale", 6.0); set_in(grain, "Detail", 10.0)
    link(nt, mp.outputs["Vector"], wave.inputs["Vector"]); link(nt, mp.outputs["Vector"], grain.inputs["Vector"])
    mix = n.new("ShaderNodeMix"); mix.data_type = 'FLOAT'; set_in(mix, "Factor", 0.35)
    link(nt, wave.outputs["Fac"], mix.inputs[2]); link(nt, grain.outputs["Fac"], mix.inputs[3])
    ramp = n.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.25; ramp.color_ramp.elements[0].color = (*srgb("#5A3418"), 1)
    ramp.color_ramp.elements[1].position = 0.8;  ramp.color_ramp.elements[1].color = (*srgb("#A8703E"), 1)
    link(nt, mix.outputs[0], ramp.inputs["Fac"]); link(nt, ramp.outputs["Color"], bsdf.inputs["Base Color"])
    set_in(bsdf, "Roughness", 0.42); set_in(bsdf, "Coat Weight", 0.25); set_in(bsdf, "Coat Roughness", 0.2)
    bp = n.new("ShaderNodeBump"); set_in(bp, "Strength", 0.08)
    link(nt, mix.outputs[0], bp.inputs["Height"]); link(nt, bp.outputs["Normal"], bsdf.inputs["Normal"])
    return m

def matte(name, hx, rough=0.9):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    set_in(b, "Base Color", (*srgb(hx), 1)); set_in(b, "Roughness", rough)
    return m

# ---- geometry --------------------------------------------------------------
S, CUBIE = 1.0, 0.97
cube_mesh = bpy.data.meshes.new("Cubie")
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=CUBIE); bm.to_mesh(cube_mesh); bm.free()
cube_mesh.materials.append(M_BODY)
for p in cube_mesh.polygons: p.use_smooth = True

def rounded_square(name, half, r, seg=10):
    pts = []
    for cx, cy, a0 in ((half - r, half - r, 0), (-half + r, half - r, 90),
                       (-half + r, -half + r, 180), (half - r, -half + r, 270)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a), 0))
    me = bpy.data.meshes.new(name); me.from_pydata(pts, [], [list(range(len(pts)))]); return me
st_mesh = rounded_square("Sticker", 0.42, 0.09)

def add_obj(name, data, c):
    o = bpy.data.objects.new(name, data); c.objects.link(o); return o

LIFT = 1.5 - (S - CUBIE) / 2   # cube centre height, so the cube rests on the desk (z=0)

cubies = {}
for x in (-1, 0, 1):
    for y in (-1, 0, 1):
        for z in (-1, 0, 1):
            if (x, y, z) == (0, 0, 0):
                continue
            o = add_obj(f"Cubie_{x:+d}{y:+d}{z:+d}", cube_mesh, C_CUBE)
            o.location = (x * S, y * S, z * S + LIFT)
            bv = o.modifiers.new("Bevel", "BEVEL"); bv.width = 0.07; bv.segments = 5; bv.harden_normals = True
            cubies[(x, y, z)] = o
            for nrm, mat in M_ST.items():
                nv = Vector(nrm)
                if Vector((x, y, z)).dot(nv) != 1:
                    continue
                me = st_mesh.copy(); me.materials.append(mat)
                s = add_obj(f"Sticker_{x:+d}{y:+d}{z:+d}_{STICKERS[nrm][0]}", me, C_CUBE)
                s.parent = o   # local transform: identity parent inverse
                s.rotation_euler = nv.to_track_quat('Z', 'Y').to_euler()
                s.location = nv * (CUBIE / 2 + 0.0005)
                so = s.modifiers.new("Thickness", "SOLIDIFY"); so.thickness = 0.008; so.offset = 1
                bv2 = s.modifiers.new("Bevel", "BEVEL"); bv2.width = 0.003; bv2.segments = 2

# ---- set: desk, wall, props ------------------------------------------------
desk_me = bpy.data.meshes.new("Desk")   # real size in the mesh, so the grain is not stretched
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
bmesh.ops.scale(bm, vec=(24, 14, 0.4), verts=bm.verts); bm.to_mesh(desk_me); bm.free()
desk = add_obj("Desk", desk_me, C_SET)
desk.location = (0, 2, -0.2)
bv = desk.modifiers.new("Bevel", "BEVEL"); bv.width = 0.05; bv.segments = 3
desk_me.materials.append(wood())

wall_me = bpy.data.meshes.new("Wall")
bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=20); bm.to_mesh(wall_me); bm.free()
wall = add_obj("Wall", wall_me, C_SET)
wall.rotation_euler = (math.radians(90), 0, 0); wall.location = (0, 8.5, 8)
wall_me.materials.append(matte("Plaster", "#C9C2B6"))

# a small stack of books behind the cube, out of focus
book_cols = ["#2F4858", "#8C3B2E", "#D8CBB0"]
zb = 0.0
for i, (w, d, h, rot) in enumerate([(3.4, 2.4, 0.45, 8), (3.0, 2.2, 0.35, -5), (3.2, 2.3, 0.4, 14)]):
    me = bpy.data.meshes.new(f"Book{i}")
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(me); bm.free()
    b = add_obj(f"Book{i}", me, C_SET)
    b.scale = (w, d, h); b.location = (-4.6, 4.2, zb + h / 2); b.rotation_euler = (0, 0, math.radians(rot))
    bb = b.modifiers.new("Bevel", "BEVEL"); bb.width = 0.04; bb.segments = 3
    me.materials.append(matte(f"Book{i}", book_cols[i], 0.6))
    zb += h

# ---- rig -------------------------------------------------------------------
arm_data = bpy.data.armatures.new("RubiksRig")
arm = add_obj("RubiksRig", arm_data, C_RIG)
arm.location = (0, 0, LIFT)
arm.show_in_front = True
arm_data.display_type = 'OCTAHEDRAL'

def wire_mesh(name, verts, edges):
    me = bpy.data.meshes.new(name); me.from_pydata(verts, edges, []); return add_obj(name, me, C_WGT)
h = 0.5
cv = [(sx * h, sy * h, sz * h) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
ce = [(i, j) for i in range(8) for j in range(i + 1, 8) if bin(i ^ j).count("1") == 1]
W_CUBIE = wire_mesh("WGT_Cubie", cv, ce)
N = 48
W_ROOT = wire_mesh("WGT_Root", [(2.4 * math.cos(2 * math.pi * i / N), 2.4 * math.sin(2 * math.pi * i / N), 0) for i in range(N)],
                   [(i, (i + 1) % N) for i in range(N)])

bpy.context.view_layer.objects.active = arm
for o in bpy.context.selected_objects: o.select_set(False)
arm.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones
root = eb.new("Root"); root.head = (0, 0, -LIFT); root.tail = (0, 1.2, -LIFT); root.roll = 0
for key in cubies:
    b = eb.new("Cubie_%+d%+d%+d" % key)
    b.head = (0, 0, 0); b.tail = (0, 0.3, 0); b.roll = 0   # identity rest orientation
    b.parent = root; b.use_deform = False
bpy.ops.object.mode_set(mode='POSE')
for pb in arm.pose.bones:
    pb.rotation_mode = 'QUATERNION'
    if pb.name == "Root":
        pb.custom_shape = W_ROOT; pb.use_custom_shape_bone_size = False
        continue
    key = tuple(int(pb.name[6 + 2 * i:8 + 2 * i]) for i in range(3))
    pb["home"] = [float(k) for k in key]
    pb.custom_shape = W_CUBIE; pb.use_custom_shape_bone_size = False
    pb.custom_shape_translation = key
    pb.custom_shape_scale_xyz = (0.9, 0.9, 0.9)
    pb.lock_location = (True, True, True); pb.lock_scale = (True, True, True)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.context.view_layer.update()

for key, o in cubies.items():
    mw = o.matrix_world.copy()
    o.parent = arm; o.parent_type = 'BONE'; o.parent_bone = "Cubie_%+d%+d%+d" % key
    bpy.context.view_layer.update()
    o.matrix_world = mw

# ---- camera, light, world --------------------------------------------------
focus = add_obj("Focus", None, C_RIG); focus.location = (0, 0, LIFT); focus.empty_display_size = 0.3
cam = add_obj("Camera", bpy.data.cameras.new("Camera"), root_coll)
cam.location = (8.6, -12.0, 7.2)
cam.rotation_euler = (Vector((0, 0.2, 1.4)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.lens = 60
cam.data.dof.use_dof = True; cam.data.dof.focus_object = focus; cam.data.dof.aperture_fstop = 2.2
scene.camera = cam

def area(name, loc, target, energy, size, color, shape='RECTANGLE', size_y=None):
    L = bpy.data.lights.new(name, 'AREA'); L.energy = energy; L.color = color
    L.shape = shape; L.size = size; L.size_y = size_y or size
    o = add_obj(name, L, root_coll); o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return o
area("Window_Key", (-7, -5, 7), (0, 0, 1), 2600, 5, (1.0, 0.93, 0.84), size_y=3.5)
area("Fill", (8, -6, 3), (0, 0, 1.5), 350, 6, (0.85, 0.9, 1.0))
area("Rim", (3, 7, 6), (0, 0, 1.5), 900, 2.5, (0.9, 0.95, 1.0))

world = scene.world or bpy.data.worlds.new("World"); scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (*srgb("#3A3632"), 1); bg.inputs["Strength"].default_value = 0.35

scene.render.engine = 'CYCLES'
scene.cycles.samples = 128; scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 1600, 1200
scene.render.use_motion_blur = True
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.fps = 24

# ---- demo animation --------------------------------------------------------
txt = bpy.data.texts.get("rubiks_turns.py") or bpy.data.texts.new("rubiks_turns.py")
txt.from_string(open(HERE + "/rubiks_turns.py").read())
ns = {}; exec(txt.as_string(), ns)
ns["reset_pose"]()
SCRAMBLE = "R U R' F2 D L' B U2"
end = ns["sequence"](SCRAMBLE, start=10, frames=12, gap=4)
end = ns["sequence"](ns["inverse"](SCRAMBLE), start=end + 24, frames=12, gap=4)
scene.frame_start, scene.frame_end = 1, end + 20
scene.frame_set(1)
print("bones", len(arm.pose.bones), "cubies", len(cubies),
      "stickers", sum(o.name.startswith("Sticker") for o in C_CUBE.objects), "frames", scene.frame_end)
