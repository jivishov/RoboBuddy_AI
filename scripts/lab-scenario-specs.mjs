const task = (robotId, rank, id, title, techniques, brief, skills, workflow) => ({
  robotId, rank, id, title, techniques, brief, skills, workflow
});

export const ROBOTS = Object.freeze({
  arduino_arm: {
    label: "Arduino Arm",
    form: "single-arm manipulator",
    limitations: "Kinematic six-servo arm; no force sensing, collision planner, or fluid physics."
  },
  so101_follower: {
    label: "SO-101 Follower",
    form: "single-arm follower",
    limitations: "Kinematic follower arm; no force sensing, collision planner, or fluid physics."
  },
  lekiwi_sim: {
    label: "LeKiwi",
    form: "holonomic mobile manipulator",
    limitations: "Kinematic mobile base and arm; routes are authored station-to-station motions, not autonomous path planning."
  },
  openarm_v2_bimanual: {
    label: "OpenArm V2 Bimanual",
    form: "bimanual manipulator",
    limitations: "Kinematic dual-arm visualization without torque planning, force sensing, or full collision planning."
  },
  unitree_g1_29dof: {
    label: "Unitree G1",
    form: "humanoid lab runner",
    limitations: "Scripted kinematic walking with fixed-hand secured carriers; no dynamic balance or fine glassware manipulation."
  }
});

// Workflow grammar:
// g object zone [effector]                  grasp
// p object zone [effector]                  place
// i object target zone [effector]           insert
// t object target zone [effector]           pour_into (discrete transfer)
// o control mode zone [value] [effector]    operate
// r instrument zone                         read_instrument
// n field value                             record_observation
// k object zone hand                        pick_nearest (G1 carrier)
// x object zone hand                        release_object (G1 carrier)
// h                                         home
export const TASKS = Object.freeze([
  task("arduino_arm", 1, "arduino-arm-01-balance-placement", "Balance Placement", ["weighing"], "Place a dry watch glass on the balance and return home.", ["placement", "homing"], ["g watch_glass supply_zone", "p watch_glass balance_zone", "h"]),
  task("arduino_arm", 2, "arduino-arm-02-volume-staging", "Volume Station Setup", ["measuring-volume"], "Stage a graduated cylinder and sealed sample bottle in compatible measuring zones.", ["staging", "compatibility"], ["g graduated_cylinder supply_zone", "p graduated_cylinder measuring_zone", "g sample_bottle supply_zone", "p sample_bottle measuring_zone", "h"]),
  task("arduino_arm", 3, "arduino-arm-03-cuvette-insertion", "Cuvette Insertion", ["blue1-percent-transmittance"], "Insert an intact, correctly oriented cuvette in the spectrophotometer.", ["orientation", "insertion"], ["g sample_cuvette cuvette_rack_zone", "i sample_cuvette spectrophotometer instrument_zone", "h"]),
  task("arduino_arm", 4, "arduino-arm-04-filter-paper-setup", "Filter Paper Setup", ["filtration"], "Seat filter paper in the funnel and place the assembled funnel on its stand.", ["assembly", "insertion"], ["g filter_paper supply_zone", "i filter_paper gravity_funnel filtration_zone", "g gravity_funnel filtration_zone", "p gravity_funnel stand_zone"]),
  task("arduino_arm", 5, "arduino-arm-05-flask-under-burette", "Receiver Placement", ["titration-endpoint"], "Position the receiving flask below the burette without an invalid collision.", ["precision placement"], ["g erlenmeyer_flask supply_zone", "p erlenmeyer_flask burette_receiver_zone", "h"]),
  task("arduino_arm", 6, "arduino-arm-06-cool-then-weigh", "Cool, Then Weigh", ["two-stage-precipitate-drying"], "Obey the cooling gate before moving the dried assembly to the balance.", ["thermal gate", "weighing"], ["o cooling_rack cool cooling_zone dried_watch_glass", "g dried_watch_glass cooling_zone", "p dried_watch_glass balance_zone", "r balance balance_zone"]),
  task("arduino_arm", 7, "arduino-arm-07-chromatography-paper", "Paper Chamber Load", ["paper-chromatography"], "Orient the paper so its origin remains above the configured solvent line.", ["orientation", "chromatography"], ["g chromatography_paper supply_zone", "i chromatography_paper chromatography_chamber chromatography_zone", "h"]),
  task("arduino_arm", 8, "arduino-arm-08-blank-read-return", "Blank, Read, Return", ["transmittance-dilution"], "Load a blank, read the simulated instrument state, and return the cuvette.", ["instrument handling"], ["g blank_cuvette cuvette_rack_zone", "i blank_cuvette spectrophotometer instrument_zone", "r spectrophotometer instrument_zone", "g blank_cuvette instrument_zone", "p blank_cuvette cuvette_rack_zone"]),
  task("arduino_arm", 9, "arduino-arm-09-burette-condition-fill", "Condition and Fill", ["titration-endpoint"], "Condition and fill the burette, remove the filling funnel, then read the level.", ["sequence", "burette setup"], ["o burette condition burette_zone", "g filling_funnel supply_zone", "i filling_funnel burette burette_zone", "o burette fill burette_zone", "g filling_funnel burette_zone", "p filling_funnel supply_zone", "r burette burette_zone"]),
  task("arduino_arm", 10, "arduino-arm-10-two-stage-drying", "Two-Stage Drying Cycle", ["two-stage-precipitate-drying"], "Complete two drying stages followed by cooling and simulated balance reads.", ["multi-cycle thermal handling"], ["o drying_oven dry_stage_1 oven_zone", "o drying_oven dry_stage_2 oven_zone", "o cooling_rack cool cooling_zone dried_watch_glass", "g dried_watch_glass cooling_zone", "p dried_watch_glass balance_zone", "r balance balance_zone", "n cooled_combined_mass simulated_readout"]),

  task("so101_follower", 1, "so101-01-weigh-boat", "Weigh Boat Placement", ["weighing"], "Place a clean, dry weigh boat on the balance without invalid contact.", ["placement", "grip control"], ["g weigh_boat supply_zone", "p weigh_boat balance_zone", "h"]),
  task("so101_follower", 2, "so101-02-mixing-station", "Mixing Station Delivery", ["making-solution"], "Stage the reagent bottle and volumetric flask at the mixing station.", ["staging", "compatibility"], ["g reagent_bottle supply_zone", "p reagent_bottle mixing_zone", "g volumetric_flask supply_zone", "p volumetric_flask mixing_zone"]),
  task("so101_follower", 3, "so101-03-cuvette-orientation", "Precision Cuvette Load", ["blue1-percent-transmittance"], "Insert, read, and remove an oriented cuvette.", ["precision insertion", "instrument handling"], ["g sample_cuvette cuvette_rack_zone", "i sample_cuvette spectrophotometer instrument_zone", "r spectrophotometer instrument_zone", "g sample_cuvette instrument_zone", "p sample_cuvette cuvette_rack_zone"]),
  task("so101_follower", 4, "so101-04-filter-assembly", "Funnel Assembly", ["filtration"], "Assemble paper, funnel, stand, and receiver in the required order.", ["ordered assembly"], ["g filter_paper supply_zone", "i filter_paper gravity_funnel filtration_zone", "g gravity_funnel filtration_zone", "p gravity_funnel stand_zone", "g filter_flask supply_zone", "p filter_flask filtration_zone"]),
  task("so101_follower", 5, "so101-05-pipette-pump", "Pipette Pump Coupling", ["blue1-standard-dilutions"], "Couple the assigned pump to its volumetric pipette.", ["coupling", "compatibility"], ["g pipette_pump supply_zone", "i pipette_pump volumetric_pipette measuring_zone", "h"]),
  task("so101_follower", 6, "so101-06-quantitative-transfer", "Transfer and Rinse", ["dilution"], "Transfer the configured aliquot into the flask and complete the required rinse.", ["transfer", "rinse"], ["g aliquot_carrier measuring_zone", "t aliquot_carrier volumetric_flask mixing_zone", "o wash_bottle rinse wash_zone transfer_vessel"]),
  task("so101_follower", 7, "so101-07-chromatography-spotting", "Precision Spotting", ["paper-chromatography"], "Position the capillary and place separated simulated spots on the origin line.", ["precision positioning"], ["g capillary supply_zone", "o chromatography_paper spot_1 chromatography_zone", "o chromatography_paper spot_2 chromatography_zone", "p capillary supply_zone"]),
  task("so101_follower", 8, "so101-08-burette-initial-reading", "Burette Setup", ["titration-endpoint"], "Mount, condition, fill, remove the filling funnel, and read the initial level.", ["burette sequence"], ["g burette supply_zone", "p burette burette_zone", "o burette condition burette_zone", "g filling_funnel supply_zone", "i filling_funnel burette burette_zone", "o burette fill burette_zone", "g filling_funnel burette_zone", "p filling_funnel supply_zone", "r burette burette_zone"]),
  task("so101_follower", 9, "so101-09-vacuum-filtration", "Vacuum Filtration", ["gravimetric-vacuum-filtration"], "Assemble the vacuum filtration station, transfer the slurry, and wash the collected solid.", ["vacuum assembly", "transfer"], ["g buchner_funnel supply_zone", "p buchner_funnel filtration_zone", "g filter_paper supply_zone", "i filter_paper buchner_funnel filtration_zone", "o vacuum_connection connect filtration_zone", "g slurry_beaker filtration_zone", "t slurry_beaker buchner_funnel filtration_zone", "p slurry_beaker filtration_zone", "o wash_bottle wash_precipitate filtration_zone"]),
  task("so101_follower", 10, "so101-10-endpoint-assistant", "Endpoint Assistant", ["titration-endpoint"], "Prepare the receiver and deliver simulated titrant dropwise through the endpoint sequence.", ["coordinated delivery"], ["g erlenmeyer_flask supply_zone", "p erlenmeyer_flask burette_receiver_zone", "o burette_stopcock dropwise burette_zone", "r endpoint_indicator burette_receiver_zone", "o burette_stopcock close burette_zone"]),

  task("lekiwi_sim", 1, "lekiwi-01-beaker-courier", "Beaker Courier", ["transfer"], "Collect and deliver an empty beaker between stations.", ["mobile pickup", "delivery"], ["g empty_beaker supply_zone", "p empty_beaker transfer_zone", "h"]),
  task("lekiwi_sim", 2, "lekiwi-02-sample-fetch", "Sample Bottle Fetch", ["measuring-volume"], "Retrieve the assigned sealed sample carrier for the measuring station.", ["retrieval", "docking"], ["g sealed_sample_carrier storage_zone", "p sealed_sample_carrier measuring_zone", "h"]),
  task("lekiwi_sim", 3, "lekiwi-03-mobile-weighing", "Mobile Weighing Run", ["weighing"], "Dock and place a dry watch glass on the balance.", ["docking", "placement"], ["g watch_glass supply_zone", "p watch_glass balance_zone", "h"]),
  task("lekiwi_sim", 4, "lekiwi-04-cuvette-rack", "Cuvette Rack Courier", ["blue1-percent-transmittance"], "Move the locked cuvette rack to the instrument station.", ["mobile delivery"], ["g locked_cuvette_rack storage_zone", "p locked_cuvette_rack instrument_zone", "h"]),
  task("lekiwi_sim", 5, "lekiwi-05-waste-return", "Waste Carrier Return", ["crystal-violet-waste-treatment"], "Deliver the closed carrier to the configured waste station.", ["closed-waste transport"], ["g closed_waste_carrier work_zone", "p closed_waste_carrier waste_zone", "h"]),
  task("lekiwi_sim", 6, "lekiwi-06-dilution-route", "Dilution Station Circuit", ["dilution"], "Visit stock, measuring, flask, and wash stations in order.", ["multi-stop route"], ["g sealed_stock_carrier stock_zone", "p sealed_stock_carrier measuring_zone", "g volumetric_flask measuring_zone", "p volumetric_flask mixing_zone", "o wash_station visit wash_zone"]),
  task("lekiwi_sim", 7, "lekiwi-07-filtration-supply", "Filtration Supply Run", ["gravimetric-vacuum-filtration"], "Deliver filter paper, wash bottle, and sealed sample to filtration.", ["multi-item logistics"], ["g filter_supply_bin storage_zone", "p filter_supply_bin filtration_zone", "g wash_bottle_carrier storage_zone", "p wash_bottle_carrier filtration_zone", "g sealed_sample_carrier storage_zone", "p sealed_sample_carrier filtration_zone"]),
  task("lekiwi_sim", 8, "lekiwi-08-cooled-precipitate", "Cooled Sample Delivery", ["two-stage-precipitate-drying"], "Avoid the hot zone and deliver only the cooled secured tray.", ["thermal gate", "route planning"], ["o cooling_rack confirm_cooled cooling_zone cooled_sample_tray", "g cooled_sample_tray cooling_zone", "p cooled_sample_tray balance_zone"]),
  task("lekiwi_sim", 9, "lekiwi-09-spectro-route", "Spectrophotometry Route", ["crystal-violet-spectrophotometer-calibration"], "Move blank and sample racks through the configured station sequence.", ["instrument logistics"], ["g locked_blank_rack storage_zone", "p locked_blank_rack instrument_zone", "g locked_sample_rack storage_zone", "p locked_sample_rack instrument_zone", "o instrument_queue route_complete instrument_zone"]),
  task("lekiwi_sim", 10, "lekiwi-10-hard-water-logistics", "Gravimetry Circuit", ["hard-water-gravimetry"], "Coordinate filtration, drying, cooling, and balance deliveries.", ["multi-station logistics"], ["g filtration_carrier filtration_zone", "p filtration_carrier oven_zone", "o drying_oven dry oven_zone", "g filtration_carrier oven_zone", "p filtration_carrier cooling_zone", "o cooling_rack cool cooling_zone filtration_carrier", "g filtration_carrier cooling_zone", "p filtration_carrier balance_zone"]),

  task("openarm_v2_bimanual", 1, "openarm-01-weighing-handoff", "Two-Hand Weighing Handoff", ["weighing"], "Coordinate watch-glass placement and spatula return with separate grippers.", ["bimanual ownership"], ["g watch_glass supply_zone left", "p watch_glass balance_zone left", "g spatula balance_zone right", "p spatula supply_zone right"]),
  task("openarm_v2_bimanual", 2, "openarm-02-stabilized-solvent-addition", "Stabilized Addition", ["making-solution"], "Stabilize the flask while positioning the solvent bottle.", ["bimanual stabilization"], ["g volumetric_flask mixing_zone left", "g solvent_bottle supply_zone right", "t solvent_bottle volumetric_flask mixing_zone right", "p solvent_bottle supply_zone right", "p volumetric_flask mixing_zone left"]),
  task("openarm_v2_bimanual", 3, "openarm-03-stopper-and-mix", "Stopper and Mix", ["transmittance-dilution"], "Hold the flask, seat the stopper, and execute the authored mixing operation.", ["bimanual sequence"], ["g volumetric_flask mixing_zone left", "g flask_stopper supply_zone right", "i flask_stopper volumetric_flask mixing_zone right", "o volumetric_flask invert_mix mixing_zone none left", "p volumetric_flask mixing_zone left"]),
  task("openarm_v2_bimanual", 4, "openarm-04-pipette-loading", "Pipette and Pump Loading", ["blue1-standard-dilutions"], "Hold the pipette and attach the compatible pump.", ["bimanual coupling"], ["g volumetric_pipette measuring_zone left", "g pipette_pump supply_zone right", "i pipette_pump volumetric_pipette measuring_zone right", "p volumetric_pipette measuring_zone left"]),
  task("openarm_v2_bimanual", 5, "openarm-05-filter-assembly", "Bimanual Filter Assembly", ["filtration"], "Stabilize the stand while assembling the filter.", ["bimanual assembly"], ["g ring_stand filtration_zone left", "g gravity_funnel supply_zone right", "i gravity_funnel ring_stand filtration_zone right", "g filter_paper supply_zone right", "i filter_paper gravity_funnel filtration_zone right", "p ring_stand filtration_zone left"]),
  task("openarm_v2_bimanual", 6, "openarm-06-controlled-pour", "Controlled Bimanual Pour", ["transfer"], "Stabilize the receiver and execute a discrete transfer without overflow.", ["bimanual transfer"], ["g receiving_beaker transfer_zone left", "g source_beaker supply_zone right", "t source_beaker receiving_beaker transfer_zone right", "p source_beaker supply_zone right", "p receiving_beaker transfer_zone left"]),
  task("openarm_v2_bimanual", 7, "openarm-07-buchner-station", "Buchner Station Assembly", ["gravimetric-vacuum-filtration"], "Assemble funnel, flask, paper, and vacuum connection.", ["vacuum assembly"], ["g filter_flask supply_zone left", "p filter_flask filtration_zone left", "g buchner_funnel supply_zone right", "i buchner_funnel filter_flask filtration_zone right", "g filter_paper supply_zone right", "i filter_paper buchner_funnel filtration_zone right", "o vacuum_connection connect filtration_zone"]),
  task("openarm_v2_bimanual", 8, "openarm-08-separatory-funnel", "Hold, Vent, and Recover", ["quick-ache-extraction-recovery"], "Preserve fraction identity through simulated mixing, venting, settling, and recovery.", ["bimanual fraction handling"], ["g separatory_funnel extraction_zone left", "o separatory_funnel mix_and_vent extraction_zone none right", "o separatory_funnel settle extraction_zone none left", "o separatory_funnel_stopcock recover_lower_fraction extraction_zone none right", "p separatory_funnel extraction_zone left"]),
  task("openarm_v2_bimanual", 9, "openarm-09-titration-coordination", "Stopcock and Flask Coordination", ["titration-endpoint"], "Coordinate receiver motion and stopcock operation through a configured endpoint event.", ["bimanual titration"], ["g erlenmeyer_flask supply_zone left", "p erlenmeyer_flask burette_receiver_zone left", "o burette_stopcock dropwise burette_zone none right", "r endpoint_indicator burette_receiver_zone", "o burette_stopcock close burette_zone none right"]),
  task("openarm_v2_bimanual", 10, "openarm-10-gravimetric-workcell", "Gravimetric Workcell", ["hard-water-gravimetry"], "Execute filtration, washing, drying transfer, cooling, and reweigh handling.", ["integrated workcell"], ["g filter_flask supply_zone left", "p filter_flask filtration_zone left", "o vacuum_connection connect filtration_zone none right", "g slurry_beaker filtration_zone right", "t slurry_beaker buchner_funnel filtration_zone right", "p slurry_beaker filtration_zone right", "o wash_bottle wash_precipitate filtration_zone none right", "g secured_drying_tray filtration_zone left", "p secured_drying_tray oven_zone left", "o drying_oven dry oven_zone", "g secured_drying_tray oven_zone left", "p secured_drying_tray cooling_zone left", "o cooling_rack cool cooling_zone secured_drying_tray", "g secured_drying_tray cooling_zone left", "p secured_drying_tray balance_zone left", "r balance balance_zone"]),

  task("unitree_g1_29dof", 1, "g1-01-empty-tray", "Empty Tray Delivery", ["transfer"], "Collect, deliver, release, and return to a neutral posture.", ["secured carrier delivery"], ["k empty_tray supply_zone right_hand", "x empty_tray transfer_zone right_hand", "h"]),
  task("unitree_g1_29dof", 2, "g1-02-sealed-sample", "Sealed Sample Carrier", ["measuring-volume"], "Carry a secured sample tote to the preparation station.", ["fixed-hand transport"], ["k sealed_sample_tote storage_zone right_hand", "x sealed_sample_tote preparation_zone right_hand", "h"]),
  task("unitree_g1_29dof", 3, "g1-03-cuvette-rack", "Cuvette Rack Courier", ["blue1-percent-transmittance"], "Transport a locked cuvette rack to the instrument station.", ["fixed-hand transport"], ["k locked_cuvette_rack storage_zone right_hand", "x locked_cuvette_rack instrument_zone right_hand", "h"]),
  task("unitree_g1_29dof", 4, "g1-04-filtration-kit", "Filtration Kit Delivery", ["filtration"], "Deliver a closed supply bin to filtration.", ["fixed-hand transport"], ["k closed_filter_bin storage_zone right_hand", "x closed_filter_bin filtration_zone right_hand", "h"]),
  task("unitree_g1_29dof", 5, "g1-05-waste-carrier", "Sealed Waste Transfer", ["crystal-violet-waste-treatment"], "Move a closed waste carrier to the configured waste station.", ["closed-waste transport"], ["k closed_waste_carrier work_zone right_hand", "x closed_waste_carrier waste_zone right_hand", "h"]),
  task("unitree_g1_29dof", 6, "g1-06-cooled-sample-tray", "Cooled Tray Transfer", ["two-stage-precipitate-drying"], "Obey the cooling gate before transporting the secured tray.", ["thermal gate", "fixed-hand transport"], ["o cooling_rack confirm_cooled cooling_zone cooled_sample_tray", "k cooled_sample_tray cooling_zone right_hand", "x cooled_sample_tray balance_zone right_hand", "h"]),
  task("unitree_g1_29dof", 7, "g1-07-reagent-tote", "Reagent Tote Delivery", ["dilution"], "Carry a sealed reagent tote while avoiding restricted zones.", ["restricted-zone transport"], ["k sealed_reagent_tote storage_zone right_hand", "x sealed_reagent_tote mixing_zone right_hand", "h"]),
  task("unitree_g1_29dof", 8, "g1-08-spectro-courier-loop", "Instrument Courier Loop", ["crystal-violet-spectrophotometer-calibration"], "Complete a multi-stop locked-rack route.", ["multi-stop humanoid route"], ["k locked_cuvette_rack storage_zone right_hand", "x locked_cuvette_rack instrument_zone right_hand", "k locked_blank_rack instrument_zone left_hand", "x locked_blank_rack storage_zone left_hand", "h"]),
  task("unitree_g1_29dof", 9, "g1-09-gravimetry-logistics", "Gravimetry Logistics Loop", ["hard-water-gravimetry"], "Move secured carriers among filtration, drying, cooling, and weighing stations.", ["multi-station humanoid route"], ["k secured_gravimetry_carrier filtration_zone right_hand", "x secured_gravimetry_carrier oven_zone right_hand", "k secured_gravimetry_carrier oven_zone right_hand", "x secured_gravimetry_carrier cooling_zone right_hand", "o cooling_rack confirm_cooled cooling_zone secured_gravimetry_carrier", "k secured_gravimetry_carrier cooling_zone right_hand", "x secured_gravimetry_carrier balance_zone right_hand", "h"]),
  task("unitree_g1_29dof", 10, "g1-10-lab-runner-shift", "Lab Runner Shift", ["transfer", "filtration", "two-stage-precipitate-drying"], "Fulfill an ordered carrier queue without incompatible loads or restricted-zone entry.", ["queued logistics"], ["k secured_carrier_queue storage_zone right_hand", "x secured_carrier_queue filtration_zone right_hand", "k closed_supply_bin filtration_zone left_hand", "x closed_supply_bin work_zone left_hand", "k closed_waste_carrier work_zone right_hand", "x closed_waste_carrier waste_zone right_hand", "h"])
]);

export const SOURCE_ACTIONS = Object.freeze({
  weighing: ["place-watch-glass", "weigh-solid"],
  "measuring-volume": ["place-cylinder", "measure-20ml"],
  "making-solution": ["add-solvent", "dissolve-solid"],
  dilution: ["transfer-aliquot", "dilute-to-mark"],
  "transmittance-dilution": ["stopper-flask", "invert-to-mix", "wipe-blank-cuvette", "zero-with-blank", "record-percent-transmittance"],
  transfer: ["place-beaker", "transfer-sample"],
  filtration: ["assemble-funnel-stand", "place-filter-paper", "place-filtration-receiver", "filter-mixture", "rinse-precipitate"],
  "paper-chromatography": ["spot-sample", "develop-paper"],
  "titration-endpoint": ["condition-burette", "fill-burette", "remove-burette-funnel", "read-initial-burette", "position-flask-under-burette", "deliver-titrant"],
  "blue1-standard-dilutions": ["i1-r8-2-measure-stock", "i1-r8-2-transfer-stock", "i1-r8-2-mix"],
  "blue1-percent-transmittance": ["i1-insert-blank-cuvette", "i1-zero-instrument", "i1-remove-blank-cuvette", "i1-r8-2-condition-orient-cuvette", "i1-r8-2-insert-cuvette", "i1-r8-2-read-percent-t"],
  "gravimetric-vacuum-filtration": ["place-practice-buchner", "seat-practice-filter-paper", "attach-practice-filter-flask", "confirm-practice-vacuum-connection", "filter-practice-mixture", "wash-practice-precipitate"],
  "two-stage-precipitate-drying": ["first-practice-drying", "second-practice-drying", "cool-practice-assembly", "weigh-practice-combined"],
  "hard-water-gravimetry": [
    "filter-hard-water-mixture",
    "rinse-precipitate",
    "first-hard-water-drying",
    "second-hard-water-drying",
    "weigh-hard-water-combined"
  ],
  "crystal-violet-spectrophotometer-calibration": ["cv11-insert-blank", "cv11-zero-spectrophotometer", "cv11-remove-blank", "cv11-insert-cuvette-05", "cv11-read-absorbance-05"],
  "crystal-violet-waste-treatment": ["cv11-transfer-cv-waste", "cv11-verify-neutralization-and-disposal"],
  "quick-ache-extraction-recovery": ["qar-mix-and-vent", "qar-settle-and-observe-layers", "qar-identify-layer-from-evidence", "qar-drain-lower-layer", "qar-drain-upper-layer"]
});

export const SOURCE_TITLES = Object.freeze({
  weighing: "Weigh a Solid", "measuring-volume": "Measure Liquid Volume", "making-solution": "Make a Solution",
  dilution: "Dilute a Stock Solution", "transmittance-dilution": "Analyze Transmittance of a Dilution",
  transfer: "Transfer Liquid", filtration: "Filter a Precipitate", "paper-chromatography": "Paper Chromatography",
  "titration-endpoint": "Acid-Base Titration to an Indicator Endpoint", "blue1-standard-dilutions": "Blue #1 Standard Dilutions",
  "blue1-percent-transmittance": "Blue #1 Percent-Transmittance Measurement", "gravimetric-vacuum-filtration": "Gravimetric Vacuum Filtration",
  "two-stage-precipitate-drying": "Two-Stage Precipitate Drying", "hard-water-gravimetry": "Hard Water Gravimetry",
  "crystal-violet-spectrophotometer-calibration": "Crystal Violet Spectrophotometer Calibration",
  "crystal-violet-waste-treatment": "Crystal Violet Waste Treatment",
  "quick-ache-extraction-recovery": "Quick Ache Extraction, Recovery, and Gravimetry"
});
