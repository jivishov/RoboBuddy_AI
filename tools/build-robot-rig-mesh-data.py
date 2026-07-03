#!/usr/bin/env python3
"""Bake URDF robots (SO-101, LeKiwi) into browser-safe quantized mesh modules.

Downloads each robot's URDF plus the STL meshes it references, collapses the
fixed-joint subassemblies into one group per movable joint, converts URDF
Z-up meters into the simulator's Y-up coordinate frame, decimates every unique STL
with grid vertex clustering, and emits an ES module per robot:

    simulator/js/robot-mesh-data-so101.js
    simulator/js/robot-mesh-data-lekiwi.js

Each module exports ROBOT_RIG_MESH_DATA containing the kinematic chain
(pivots, base quaternions, joint axes mapped to robot-pack manifest joint
ids), mesh part instances (position/quaternion/scale), and quantized
position buffers in the same "robobuddy-quantized-position-v1" format used
by arm-preview-mesh-data.js. STL vertices are pre-rotated into the Three.js
Y-up geometry frame; generated link and visual transforms are also expressed in
that frame so the renderer never mixes URDF-space mesh vertices with Three-space
link transforms.

Usage:
    python tools/build-robot-rig-mesh-data.py [--robot so101|lekiwi|all]
                                              [--offline] [--out simulator/js]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import re
import struct
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / ".cache" / "robot-meshes"
QUANTIZATION = 65535
FORMAT_NAME = "robobuddy-quantized-position-v1"

# Global frame conversion: URDF Z-up meters -> three.js Y-up millimeters.
# R = rotation by -90 deg about X: (x, y, z) -> (x, z, -y).
CONV_R = np.array([
    [1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0],
    [0.0, -1.0, 0.0],
])
CONV_SCALE = 1000.0


# ---------------------------------------------------------------------------
# Robot recipes
# ---------------------------------------------------------------------------

ROBOTS = {
    "so101": {
        "robotId": "so101_follower",
        "title": "LeRobot SO-101 Follower",
        "urdf_url": "https://raw.githubusercontent.com/TheRobotStudio/SO-ARM100/main/Simulation/SO101/so101_new_calib.urdf",
        "mesh_base_url": "https://raw.githubusercontent.com/TheRobotStudio/SO-ARM100/main/Simulation/SO101/",
        "out_file": "robot-mesh-data-so101.js",
        # URDF joint name -> robot pack manifest joint id.
        "joint_map": {
            "shoulder_pan": "shoulder_pan",
            "shoulder_lift": "shoulder_lift",
            "elbow_flex": "elbow_flex",
            "wrist_flex": "wrist_flex",
            "wrist_roll": "wrist_roll",
        },
        # The gripper revolute drives the moving jaw from a percent value.
        "gripper_joint": "gripper",
        "gripper": {"openDeg": 88.0, "closedDeg": 1.0, "sign": 1},
        # URDF material name -> palette key.
        "material_map": {"3d_printed": "printed", "sts3215": "servo"},
        "materials": {
            "printed": {"color": 0xFFD11F, "roughness": 0.62, "metalness": 0.03},
            "servo": {"color": 0x23262D, "roughness": 0.72, "metalness": 0.08},
            "fallback": {"color": 0xFF6B6B, "roughness": 0.55, "metalness": 0.02},
        },
        "budgets": [
            (r"base_so101", 1800),
            (r"upper_arm|under_arm", 1400),
            (r"wrist_roll_follower", 1400),
            (r"wrist_roll_pitch", 1100),
            (r"moving_jaw", 1000),
            (r"sts3215", 900),
            (r"motor_holder", 1100),
            (r"waveshare", 600),
            (r"rotation_pitch", 1100),
        ],
        "default_budget": 1100,
    },
    "lekiwi": {
        "robotId": "lekiwi_sim",
        "title": "LeKiwi Mobile Manipulator",
        "urdf_url": "https://raw.githubusercontent.com/SIGRobotics-UIUC/LeKiwi/main/URDF/LeKiwi.urdf",
        "mesh_base_url": "https://raw.githubusercontent.com/SIGRobotics-UIUC/LeKiwi/main/URDF/",
        "out_file": "robot-mesh-data-lekiwi.js",
        "joint_map": {
            "STS3215_03a-v1_Revolute-45": "shoulder_pan",
            "STS3215_03a-v1-1_Revolute-49": "shoulder_lift",
            "STS3215_03a-v1-2_Revolute-51": "elbow_flex",
            "STS3215_03a-v1-3_Revolute-53": "wrist_flex",
            "STS3215_03a_Wrist_Roll-v1_Revolute-55": "wrist_roll",
        },
        "gripper_joint": "STS3215_03a-v1-4_Revolute-57",
        "gripper": {"openDeg": 88.0, "closedDeg": 1.0, "sign": -1},
        "material_map": {},
        # Ordered regex heuristics (LeKiwi URDF ships no materials).
        "material_rules": [
            (r"omni-directional-wheel", "tire"),
            (r"st3215|sts3215", "servo"),
            (r"standoff", "steel"),
            (r"battery---|lipo_battery", "battery"),
            (r"camera-model", "camera"),
            (r"base_plate|bottom-v2|top-v2", "plate"),
            (r"mount|waveshare", "mountPrint"),
        ],
        "default_material": "printed",
        "materials": {
            "printed": {"color": 0xFFD11F, "roughness": 0.62, "metalness": 0.03},
            "servo": {"color": 0x23262D, "roughness": 0.72, "metalness": 0.08},
            "tire": {"color": 0x3A4048, "roughness": 0.82, "metalness": 0.04},
            "steel": {"color": 0xB9C2CD, "roughness": 0.42, "metalness": 0.32},
            "battery": {"color": 0x2F3B52, "roughness": 0.66, "metalness": 0.05},
            "camera": {"color": 0x1B1E24, "roughness": 0.6, "metalness": 0.1},
            "plate": {"color": 0x2A7F7F, "roughness": 0.68, "metalness": 0.04},
            "mountPrint": {"color": 0x5A6577, "roughness": 0.7, "metalness": 0.05},
            "fallback": {"color": 0xFF6B6B, "roughness": 0.55, "metalness": 0.02},
        },
        "budgets": [
            (r"omni-directional-wheel", 1600),
            (r"base_plate_layer", 1400),
            (r"top-v2|bottom-v2", 900),
            (r"standoff", 160),
            (r"battery", 320),
            (r"camera-model", 400),
            (r"mount", 700),
            (r"passive_horn", 300),
            (r"st3215|sts3215", 900),
            (r"moving_jaw", 1000),
        ],
        "default_budget": 1100,
    },
}


# ---------------------------------------------------------------------------
# Math helpers
# ---------------------------------------------------------------------------

def rpy_to_matrix(rpy):
    r, p, y = rpy
    cr, sr = math.cos(r), math.sin(r)
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    return rz @ ry @ rx


def make_transform(xyz, rpy):
    t = np.eye(4)
    t[:3, :3] = rpy_to_matrix(rpy)
    t[:3, 3] = xyz
    return t


def matrix_to_quaternion(m):
    """Rotation matrix (3x3) -> quaternion [x, y, z, w]."""
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    return q / np.linalg.norm(q)


def convert_point(p):
    return CONV_R @ np.asarray(p, dtype=float) * CONV_SCALE


def convert_rotation(rot):
    return CONV_R @ rot @ CONV_R.T


def convert_axis(axis):
    v = CONV_R @ np.asarray(axis, dtype=float)
    n = np.linalg.norm(v)
    if n < 1e-9:
        return np.array([0.0, 1.0, 0.0])
    v = v / n
    v[np.abs(v) < 1e-9] = 0.0
    return v / np.linalg.norm(v)


def convert_mesh_vertices(tris):
    """Rotate STL vertices from URDF Z-up meters into Three.js Y-up meters.

    Joint/group transforms are represented between already-converted coordinate
    frames with C * R * C.T. Raw STL vertices, however, arrive in their original
    URDF/STL basis. Pre-converting the vertices once keeps the renderer and the
    generated local transforms in the same coordinate space and prevents the
    visually "exploded" SO-101 assembly caused by applying converted transforms
    to unconverted geometry.
    """
    arr = np.asarray(tris, dtype=np.float64)
    flat = arr.reshape(-1, 3)
    converted = (CONV_R @ flat.T).T
    return converted.reshape(arr.shape)


def round_list(values, digits=4):
    out = []
    for v in np.asarray(values, dtype=float).ravel():
        r = round(float(v), digits)
        out.append(0.0 if r == 0 else r)
    return out


# ---------------------------------------------------------------------------
# URDF parsing
# ---------------------------------------------------------------------------

def parse_floats(text, count, default=0.0):
    if not text:
        return [default] * count
    parts = [float(x) for x in text.replace(",", " ").split()]
    while len(parts) < count:
        parts.append(default)
    return parts[:count]


def parse_urdf(path):
    tree = ET.parse(path)
    root = tree.getroot()

    materials = {}
    for mat in root.findall("material"):
        color = mat.find("color")
        if color is not None and mat.get("name"):
            rgba = parse_floats(color.get("rgba"), 4, 1.0)
            materials[mat.get("name")] = rgba

    links = {}
    for link in root.findall("link"):
        visuals = []
        for visual in link.findall("visual"):
            geometry = visual.find("geometry")
            mesh = geometry.find("mesh") if geometry is not None else None
            if mesh is None or not mesh.get("filename"):
                continue
            origin = visual.find("origin")
            xyz = parse_floats(origin.get("xyz") if origin is not None else None, 3)
            rpy = parse_floats(origin.get("rpy") if origin is not None else None, 3)
            scale = parse_floats(mesh.get("scale"), 3, 1.0) if mesh.get("scale") else [1.0, 1.0, 1.0]
            if abs(scale[0] - scale[1]) > 1e-9 or abs(scale[0] - scale[2]) > 1e-9:
                raise ValueError(f"Non-uniform mesh scale on link {link.get('name')}: {scale}")
            material = visual.find("material")
            visuals.append({
                "transform": make_transform(xyz, rpy),
                "mesh": mesh.get("filename"),
                "scale": scale[0],
                "material": material.get("name") if material is not None else None,
            })
        links[link.get("name")] = visuals

    joints = []
    for joint in root.findall("joint"):
        origin = joint.find("origin")
        xyz = parse_floats(origin.get("xyz") if origin is not None else None, 3)
        rpy = parse_floats(origin.get("rpy") if origin is not None else None, 3)
        axis_el = joint.find("axis")
        axis = parse_floats(axis_el.get("xyz") if axis_el is not None else None, 3)
        limit = joint.find("limit")
        limits = None
        if limit is not None and limit.get("lower") is not None:
            limits = [float(limit.get("lower")), float(limit.get("upper"))]
        joints.append({
            "name": joint.get("name"),
            "type": joint.get("type"),
            "parent": joint.find("parent").get("link"),
            "child": joint.find("child").get("link"),
            "transform": make_transform(xyz, rpy),
            "axis": axis,
            "limits": limits,
        })

    child_links = {j["child"] for j in joints}
    roots = [name for name in links if name not in child_links]
    if len(roots) != 1:
        raise ValueError(f"Expected a single root link, found: {roots}")
    return {"materials": materials, "links": links, "joints": joints, "root": roots[0]}


# ---------------------------------------------------------------------------
# STL loading + decimation
# ---------------------------------------------------------------------------

def parse_stl(data):
    """Return triangle soup (T, 3, 3) float64 from binary or ASCII STL."""
    if len(data) >= 84:
        (ntri,) = struct.unpack_from("<I", data, 80)
        if 84 + 50 * ntri == len(data):
            dtype = np.dtype([("n", "<f4", (3,)), ("v", "<f4", (3, 3)), ("attr", "<u2")])
            records = np.frombuffer(data, dtype=dtype, count=ntri, offset=84)
            return records["v"].astype(np.float64)
    text = data.decode("ascii", errors="ignore")
    values = re.findall(r"vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)", text)
    if not values:
        raise ValueError("Unrecognized STL payload")
    arr = np.array(values, dtype=np.float64)
    if arr.shape[0] % 3:
        raise ValueError("ASCII STL vertex count is not a multiple of 3")
    return arr.reshape(-1, 3, 3)


def cluster_decimate(tris, cells_across):
    verts = tris.reshape(-1, 3)
    bmin = verts.min(axis=0)
    bmax = verts.max(axis=0)
    diag = float(np.linalg.norm(bmax - bmin))
    if diag <= 0:
        return tris
    cell = diag / cells_across
    keys = np.floor((verts - bmin) / cell).astype(np.int64)
    unique_keys, inverse = np.unique(keys, axis=0, return_inverse=True)
    sums = np.zeros((len(unique_keys), 3))
    np.add.at(sums, inverse, verts)
    counts = np.bincount(inverse, minlength=len(unique_keys)).astype(float)
    reps = sums / counts[:, None]

    faces = inverse.reshape(-1, 3)
    keep = (
        (faces[:, 0] != faces[:, 1])
        & (faces[:, 1] != faces[:, 2])
        & (faces[:, 0] != faces[:, 2])
    )
    faces = faces[keep]
    if len(faces) == 0:
        return None
    # Drop duplicate faces regardless of winding (collapsed thin walls).
    sorted_faces = np.sort(faces, axis=1)
    _, first_idx = np.unique(sorted_faces, axis=0, return_index=True)
    faces = faces[np.sort(first_idx)]
    return reps[faces]


def decimate(tris, budget):
    if len(tris) <= budget:
        return tris
    lo, hi = 4.0, 1024.0
    best = None
    for _ in range(12):
        mid = (lo + hi) / 2.0
        candidate = cluster_decimate(tris, mid)
        if candidate is None or len(candidate) > budget:
            hi = mid
        else:
            best = candidate
            lo = mid
    if best is None:
        best = cluster_decimate(tris, 4.0)
        if best is None:
            best = tris[:budget]
    return best


def pick_by_rules(name, rules, default):
    lowered = name.lower()
    for pattern, value in rules:
        if re.search(pattern, lowered):
            return value
    return default


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

def fetch(url, cache_path, offline):
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return cache_path.read_bytes()
    if offline:
        raise FileNotFoundError(f"Offline mode and no cache for {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "RoboBuddy-mesh-bake/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(data)
    return data


# ---------------------------------------------------------------------------
# Baking
# ---------------------------------------------------------------------------

def sanitize(name):
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
    return slug or "node"


def encode_positions(soup):
    verts = soup.reshape(-1, 3).astype(np.float64)
    bmin = verts.min(axis=0)
    bmax = verts.max(axis=0)
    extent = np.maximum(bmax - bmin, 1e-12)
    ratio = np.clip((verts - bmin) / extent, 0.0, 1.0)
    quantized = np.round(ratio * QUANTIZATION).astype("<u2")
    payload = base64.b64encode(quantized.tobytes()).decode("ascii")
    bounds = round_list(np.concatenate([bmin, bmax]), 6)
    return {"bounds": bounds, "vertexCount": int(len(verts)), "positions": payload}


def bake_robot(key, recipe, out_dir, offline):
    print(f"\n=== Baking {key} ({recipe['robotId']}) ===")
    cache = CACHE_DIR / key
    urdf_bytes = fetch(recipe["urdf_url"], cache / Path(urllib.parse.urlparse(recipe["urdf_url"]).path).name, offline)
    urdf_path = cache / "model.urdf"
    urdf_path.parent.mkdir(parents=True, exist_ok=True)
    urdf_path.write_bytes(urdf_bytes)
    model = parse_urdf(urdf_path)

    joints_by_parent = {}
    for joint in model["joints"]:
        joints_by_parent.setdefault(joint["parent"], []).append(joint)

    material_map = recipe.get("material_map", {})
    material_rules = recipe.get("material_rules", [])
    default_material = recipe.get("default_material", "printed")

    def material_for(visual, mesh_name):
        urdf_name = visual.get("material")
        if urdf_name and urdf_name in material_map:
            return material_map[urdf_name]
        if material_rules:
            return pick_by_rules(mesh_name, material_rules, default_material)
        if urdf_name:
            return material_map.get(urdf_name, default_material)
        return default_material

    chain = []
    parts = []
    mesh_jobs = {}
    used_ids = {"root"}
    gripper_node_id = None
    group_world_three = {"root": np.eye(4)}  # Three.js-space group world transform at zero pose

    def unique_id(base):
        candidate = base
        suffix = 2
        while candidate in used_ids:
            candidate = f"{base}_{suffix}"
            suffix += 1
        used_ids.add(candidate)
        return candidate

    def converted_transform(matrix, scale=1.0):
        converted = np.eye(4)
        converted[:3, :3] = convert_rotation(matrix[:3, :3]) * scale
        converted[:3, 3] = convert_point(matrix[:3, 3])
        return converted

    def add_parts(link_name, group_id, acc):
        for index, visual in enumerate(model["links"].get(link_name, [])):
            local = acc @ visual["transform"]
            mesh_name = Path(visual["mesh"]).name
            mesh_jobs.setdefault(visual["mesh"], set()).add(visual["scale"])
            converted = converted_transform(local, visual["scale"] * CONV_SCALE)
            linear = converted[:3, :3]
            scale = float(np.cbrt(abs(np.linalg.det(linear))))
            rotation = linear / scale
            parts.append({
                "key": unique_id(f"{sanitize(link_name)}__{sanitize(mesh_name)}_{index}"),
                "group": group_id,
                "meshFile": visual["mesh"],
                "material": material_for(visual, mesh_name),
                "posMm": round_list(converted[:3, 3], 3),
                "quat": round_list(matrix_to_quaternion(rotation), 6),
                "scale": round(scale, 6),
                "localMatrixThree": converted,
            })

    def walk(link_name, group_id, acc):
        add_parts(link_name, group_id, acc)
        for joint in joints_by_parent.get(link_name, []):
            joint_local = acc @ joint["transform"]
            if joint["type"] in ("revolute", "continuous"):
                mapped = recipe["joint_map"].get(joint["name"])
                is_gripper = joint["name"] == recipe.get("gripper_joint")
                node_base = mapped or ("gripper_jaw" if is_gripper else sanitize(joint["name"]))
                node_id = unique_id(node_base)
                rotation = joint_local[:3, :3]
                limits_deg = None
                if joint["limits"]:
                    limits_deg = [round(math.degrees(v), 2) for v in joint["limits"]]
                chain.append({
                    "id": node_id,
                    "jointId": mapped,
                    "label": (mapped or node_base).replace("_", " ").title(),
                    "parent": group_id,
                    "pivotMm": round_list(convert_point(joint_local[:3, 3]), 3),
                    "baseQuat": round_list(matrix_to_quaternion(convert_rotation(rotation)), 6),
                    "axis": round_list(convert_axis(joint["axis"]), 6),
                    "sign": 1,
                    "limitsDeg": limits_deg,
                    "sourceJoint": joint["name"],
                })
                group_world_three[node_id] = group_world_three[group_id] @ converted_transform(joint_local)
                if is_gripper:
                    nonlocal gripper_node_id
                    gripper_node_id = node_id
                walk(joint["child"], node_id, np.eye(4))
            else:
                walk(joint["child"], group_id, joint_local)

    walk(model["root"], "root", np.eye(4))

    # Load, decimate, and dedupe meshes (by content hash of the raw file).
    budgets = recipe.get("budgets", [])
    default_budget = recipe.get("default_budget", 1100)
    mesh_entries = {}
    file_to_mesh_key = {}
    hash_to_mesh_key = {}
    total_tris = 0
    for mesh_file in sorted(mesh_jobs):
        rel = mesh_file.replace("\\", "/")
        url = recipe["mesh_base_url"] + urllib.parse.quote(rel)
        cache_path = cache / rel
        data = fetch(url, cache_path, offline)
        digest = hashlib.sha1(data).hexdigest()[:16]
        if digest in hash_to_mesh_key:
            file_to_mesh_key[mesh_file] = hash_to_mesh_key[digest]
            continue
        soup = parse_stl(data)
        budget = pick_by_rules(Path(rel).name, budgets, default_budget)
        reduced = decimate(soup, budget)
        # The browser receives geometry vertices in Three.js Y-up meters.
        # Part and joint transforms are already baked in the same Three-space.
        reduced_three = convert_mesh_vertices(reduced)
        mesh_key = sanitize(Path(rel).stem)
        if mesh_key in mesh_entries:
            mesh_key = unique_id(mesh_key)
        mesh_entries[mesh_key] = {"soup": reduced_three, **encode_positions(reduced_three)}
        hash_to_mesh_key[digest] = mesh_key
        file_to_mesh_key[mesh_file] = mesh_key
        total_tris += len(reduced)
        print(f"  {Path(rel).name}: {len(soup)} -> {len(reduced)} tris (budget {budget})")

    # Resolve part mesh keys and compute the exact same zero-pose bbox that the
    # renderer will produce: nested Three-space groups + Three-space mesh data.
    world_min = np.array([np.inf] * 3)
    world_max = np.array([-np.inf] * 3)
    for part in parts:
        part["meshKey"] = file_to_mesh_key[part.pop("meshFile")]
        local_matrix_three = part.pop("localMatrixThree")
        soup = mesh_entries[part["meshKey"]]["soup"]
        sample = soup.reshape(-1, 3)
        homogeneous = np.hstack([sample, np.ones((len(sample), 1))])
        world_pts = (group_world_three[part["group"]] @ local_matrix_three @ homogeneous.T).T[:, :3]
        world_min = np.minimum(world_min, world_pts.min(axis=0))
        world_max = np.maximum(world_max, world_pts.max(axis=0))

    for entry in mesh_entries.values():
        entry.pop("soup")

    ground_offset = round(float(-world_min[1]), 3)
    bbox = round_list(np.concatenate([world_min, world_max]), 2)

    gripper_cfg = None
    if gripper_node_id:
        gripper_cfg = {
            "jointId": "gripper",
            "node": gripper_node_id,
            "openDeg": recipe["gripper"]["openDeg"],
            "closedDeg": recipe["gripper"]["closedDeg"],
            "sign": recipe["gripper"]["sign"],
            "openValue": 20,
            "closeValue": 85,
        }

    payload = {
        "format": FORMAT_NAME,
        "robotId": recipe["robotId"],
        "title": recipe["title"],
        "units": "mm",
        "quantization": QUANTIZATION,
        "source": {
            "urdf": recipe["urdf_url"],
            "generator": "tools/build-robot-rig-mesh-data.py",
            "geometryFrame": "three-y-up-meters",
            "transformFrame": "three-y-up-millimeters",
        },
        "geometryFrame": "three-y-up-meters",
        "groundOffsetMm": ground_offset,
        "bboxMm": bbox,
        "materials": recipe["materials"],
        "chain": chain,
        "gripper": gripper_cfg,
        "parts": parts,
        "meshes": {k: {kk: vv for kk, vv in v.items()} for k, v in mesh_entries.items()},
    }

    out_path = out_dir / recipe["out_file"]
    body = json.dumps(payload, separators=(",", ":"))
    out_path.write_text(
        "// Generated by tools/build-robot-rig-mesh-data.py. Do not edit.\n"
        f"export const ROBOT_RIG_MESH_DATA = Object.freeze({body});\n",
        encoding="utf-8",
    )
    size_kb = out_path.stat().st_size / 1024
    print(f"  chain nodes: {len(chain)}, parts: {len(parts)}, unique meshes: {len(mesh_entries)}")
    print(f"  total tris: {total_tris}, ground offset: {ground_offset} mm")
    print(f"  bbox mm: {bbox}")
    print(f"  wrote {out_path} ({size_kb:.0f} KB)")


def scale_matrix(scale):
    m = np.eye(4)
    m[0, 0] = m[1, 1] = m[2, 2] = scale
    return m


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--robot", default="all", choices=["all", *ROBOTS.keys()])
    parser.add_argument("--out", default=str(REPO_ROOT / "simulator" / "js"))
    parser.add_argument("--offline", action="store_true", help="Use cached downloads only")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    targets = list(ROBOTS.keys()) if args.robot == "all" else [args.robot]
    for key in targets:
        bake_robot(key, ROBOTS[key], out_dir, args.offline)
    print("\nDone.")


if __name__ == "__main__":
    main()
