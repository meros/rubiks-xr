# Turn helper for the RubiksRig armature.
# Every cubie bone has its head at the cube centre and the identity rest
# orientation, so a pose rotation of a bone is a rotation of its cubie
# about the cube centre, in armature space.
#
#   turn("R", 1)        # clockwise R turn that starts at frame 1
#   sequence("R U R' U' F2", start=1, frames=12, gap=4)
import bpy
from mathutils import Quaternion, Vector

ARM = "RubiksRig"
# face -> (axis index, layer, sign of the outward normal used for "clockwise")
FACES = {
    "U": (2, 1, 1), "D": (2, -1, -1),
    "R": (0, 1, 1), "L": (0, -1, -1),
    "B": (1, 1, 1), "F": (1, -1, -1),
    "M": (0, 0, -1), "E": (2, 0, -1), "S": (1, 0, -1),
}
AXES = (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))


def _cubies(arm):
    return [pb for pb in arm.pose.bones if "home" in pb]


def _quarter(arm, face, prime, frame, frames):
    idx, layer, sign = FACES[face]
    angle = -sign * (3.141592653589793 / 2) * (-1 if prime else 1)
    q_turn = Quaternion(AXES[idx], angle)
    bpy.context.scene.frame_set(frame)
    for pb in _cubies(arm):
        pos = pb.rotation_quaternion @ Vector(pb["home"])
        if round(pos[idx]) != layer:
            continue
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=pb.name)
        old = pb.rotation_quaternion.copy()
        new = q_turn @ old
        if new.dot(old) < 0:
            new.negate()
        pb.rotation_quaternion = new
        pb.keyframe_insert("rotation_quaternion", frame=frame + frames, group=pb.name)


def turn(move, frame, frames=12):
    """Key one move in Singmaster notation (R, U', F2, M ...). Returns the end frame."""
    arm = bpy.data.objects[ARM]
    face, prime, double = move[0], "'" in move, "2" in move
    if double:
        half = max(1, frames // 2)
        _quarter(arm, face, prime, frame, half)
        _quarter(arm, face, prime, frame + half, frames - half)
    else:
        _quarter(arm, face, prime, frame, frames)
    return frame + frames


def sequence(moves, start=1, frames=12, gap=4):
    f = start
    for m in moves.split():
        f = turn(m, f, frames) + gap
    return f


def inverse(moves):
    out = []
    for m in reversed(moves.split()):
        out.append(m if "2" in m else (m[0] if "'" in m else m + "'"))
    return " ".join(out)


def reset_pose():
    arm = bpy.data.objects[ARM]
    if arm.animation_data and arm.animation_data.action:
        bpy.data.actions.remove(arm.animation_data.action)
    for pb in _cubies(arm):
        pb.rotation_quaternion = (1, 0, 0, 0)
