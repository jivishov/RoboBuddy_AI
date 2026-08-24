import json
import time

with open("transport.json", encoding="utf-8") as stream:
    transport = json.load(stream)
with open("workcell.json", encoding="utf-8") as stream:
    workcell = json.load(stream)

from lerobot.robots.openarm_follower import OpenArmFollowerConfigBase
from lerobot.robots.bi_openarm_follower import BiOpenArmFollower, BiOpenArmFollowerConfig
config = BiOpenArmFollowerConfig(
    left_arm_config=OpenArmFollowerConfigBase(port=transport["left_port"], side="left", cameras={}),
    right_arm_config=OpenArmFollowerConfigBase(port=transport["right_port"], side="right", cameras={}),
    cameras={},
)
robot = BiOpenArmFollower(config)

robot.connect()
try:
    for step in workcell["reference_actions"]:
        sent = robot.send_action(step["action"])
        time.sleep(step["hold_seconds"])
        observation = robot.get_observation()
        print(step["label"], observation)
finally:
    robot.disconnect()
