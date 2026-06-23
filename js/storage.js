(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const STORAGE_KEY = "roboadmin.programs.v1";

  const BUILT_IN_PROGRAMS = {
    "Wave Hello": {
      xml: `<xml xmlns="https://developers.google.com/blockly/xml"><block type="home_position" x="18" y="24"><next><block type="repeat_times"><field name="COUNT">4</field><statement name="DO"><block type="move_joint"><field name="JOINT">0</field><field name="ANGLE">60</field><field name="SPEED">55</field><next><block type="wait_seconds"><field name="SECONDS">0.4</field><next><block type="move_joint"><field name="JOINT">0</field><field name="ANGLE">120</field><field name="SPEED">55</field><next><block type="wait_seconds"><field name="SECONDS">0.4</field></block></next></block></next></block></next></block></statement></block></next></block></xml>`
    },
    "Pick and Place": {
      xml: `<xml xmlns="https://developers.google.com/blockly/xml"><block type="home_position" x="20" y="24"><next><block type="gripper_open"><next><block type="move_joint"><field name="JOINT">1</field><field name="ANGLE">130</field><field name="SPEED">50</field><next><block type="move_joint"><field name="JOINT">2</field><field name="ANGLE">55</field><field name="SPEED">50</field><next><block type="gripper_close"><next><block type="wait_seconds"><field name="SECONDS">0.5</field><next><block type="home_position"><next><block type="gripper_open"></block></next></block></next></block></next></block></next></block></next></block></next></block></xml>`
    },
    Dance: {
      xml: `<xml xmlns="https://developers.google.com/blockly/xml"><block type="repeat_times" x="24" y="20"><field name="COUNT">3</field><statement name="DO"><block type="move_joint"><field name="JOINT">1</field><field name="ANGLE">60</field><field name="SPEED">75</field><next><block type="move_joint"><field name="JOINT">2</field><field name="ANGLE">130</field><field name="SPEED">75</field><next><block type="move_joint"><field name="JOINT">1</field><field name="ANGLE">120</field><field name="SPEED">75</field><next><block type="move_joint"><field name="JOINT">2</field><field name="ANGLE">70</field><field name="SPEED">75</field></block></next></block></next></block></next></block></statement><next><block type="home_position"></block></next></block></xml>`
    },
    "Draw Circle": {
      xml: `<xml xmlns="https://developers.google.com/blockly/xml"><block type="repeat_times" x="22" y="18"><field name="COUNT">2</field><statement name="DO"><block type="smooth_move"><field name="JOINT">1</field><field name="FROM">65</field><field name="TO">120</field><field name="SECONDS">1.2</field><next><block type="smooth_move"><field name="JOINT">2</field><field name="FROM">70</field><field name="TO">130</field><field name="SECONDS">1.2</field><next><block type="smooth_move"><field name="JOINT">1</field><field name="FROM">120</field><field name="TO">65</field><field name="SECONDS">1.2</field><next><block type="smooth_move"><field name="JOINT">2</field><field name="FROM">130</field><field name="TO">70</field><field name="SECONDS">1.2</field></block></next></block></next></block></next></block></statement><next><block type="home_position"></block></next></block></xml>`
    },
    "High Five": {
      xml: `<xml xmlns="https://developers.google.com/blockly/xml"><block type="home_position" x="18" y="20"><next><block type="move_joint"><field name="JOINT">1</field><field name="ANGLE">45</field><field name="SPEED">60</field><next><block type="move_joint"><field name="JOINT">2</field><field name="ANGLE">145</field><field name="SPEED">60</field><next><block type="gripper_open"><next><block type="wait_seconds"><field name="SECONDS">1</field><next><block type="home_position"></block></next></block></next></block></next></block></next></block></next></block></xml>`
    }
  };

  function deepCloneJson(value) {
    if (value === null || value === undefined) {
      return null;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return null;
    }
  }

  class ProgramStorage {
    constructor() {
      this.key = STORAGE_KEY;
    }

    listPrograms() {
      const customPrograms = this._readCustomPrograms();

      const builtIns = Object.keys(BUILT_IN_PROGRAMS).map((name) => ({
        ...this._toPublicProgram(name, this._normalizeStoredProgram(BUILT_IN_PROGRAMS[name]), true)
      }));

      const customs = Object.entries(customPrograms)
        .map(([name, value]) => ({
          ...this._toPublicProgram(name, this._normalizeStoredProgram(value), false)
        }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

      return [...builtIns, ...customs];
    }

    getProgram(name) {
      if (BUILT_IN_PROGRAMS[name]) {
        return this._toPublicProgram(name, this._normalizeStoredProgram(BUILT_IN_PROGRAMS[name]), true);
      }

      const customPrograms = this._readCustomPrograms();
      const item = customPrograms[name];
      if (!item) {
        return null;
      }

      return this._toPublicProgram(name, this._normalizeStoredProgram(item), false);
    }

    saveProgram(name, xmlOrProgram, extraFields = null) {
      const safeName = String(name || "").trim();
      if (!safeName) {
        throw new Error("Program name cannot be empty.");
      }
      if (BUILT_IN_PROGRAMS[safeName]) {
        throw new Error("Choose a different name. Built-in program names are reserved.");
      }

      const customPrograms = this._readCustomPrograms();
      const payload = this._normalizeWritePayload(xmlOrProgram, extraFields);
      customPrograms[safeName] = {
        xml: payload.blockXml,
        blockXml: payload.blockXml,
        scriptText: payload.scriptText,
        motionIr: payload.motionIr,
        teachMeta: payload.teachMeta,
        source: payload.source,
        updatedAt: new Date().toISOString()
      };
      this._writeCustomPrograms(customPrograms);
    }

    deleteProgram(name) {
      if (!name || BUILT_IN_PROGRAMS[name]) {
        return;
      }
      const customPrograms = this._readCustomPrograms();
      if (customPrograms[name]) {
        delete customPrograms[name];
        this._writeCustomPrograms(customPrograms);
      }
    }

    _readCustomPrograms() {
      try {
        const raw = localStorage.getItem(this.key);
        if (!raw) {
          return {};
        }

        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (error) {
        return {};
      }
    }

    _writeCustomPrograms(programs) {
      localStorage.setItem(this.key, JSON.stringify(programs));
    }

    _normalizeWritePayload(xmlOrProgram, extraFields) {
      if (xmlOrProgram && typeof xmlOrProgram === "object" && !Array.isArray(xmlOrProgram)) {
        return this._normalizeStoredProgram(xmlOrProgram);
      }

      const extras = extraFields && typeof extraFields === "object" && !Array.isArray(extraFields)
        ? extraFields
        : {};

      return this._normalizeStoredProgram({
        blockXml: String(xmlOrProgram || ""),
        scriptText: extras.scriptText,
        motionIr: extras.motionIr,
        teachMeta: extras.teachMeta,
        source: extras.source
      });
    }

    _normalizeStoredProgram(value) {
      const safeValue = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const blockXml = String(
        typeof safeValue.blockXml === "string"
          ? safeValue.blockXml
          : (typeof safeValue.xml === "string" ? safeValue.xml : "")
      );

      return {
        blockXml,
        scriptText: typeof safeValue.scriptText === "string" ? safeValue.scriptText : "",
        motionIr: safeValue.motionIr && typeof safeValue.motionIr === "object" ? deepCloneJson(safeValue.motionIr) : null,
        teachMeta: safeValue.teachMeta && typeof safeValue.teachMeta === "object" ? deepCloneJson(safeValue.teachMeta) : null,
        source: typeof safeValue.source === "string" && safeValue.source ? safeValue.source : "blockly",
        updatedAt: typeof safeValue.updatedAt === "string" ? safeValue.updatedAt : ""
      };
    }

    _toPublicProgram(name, normalized, builtIn) {
      const safeProgram = normalized || this._normalizeStoredProgram({});
      return {
        name,
        xml: safeProgram.blockXml,
        blockXml: safeProgram.blockXml,
        scriptText: safeProgram.scriptText,
        motionIr: deepCloneJson(safeProgram.motionIr),
        teachMeta: deepCloneJson(safeProgram.teachMeta),
        source: builtIn ? "built-in" : safeProgram.source,
        hasScript: Boolean(safeProgram.scriptText),
        hasMotionIr: Boolean(safeProgram.motionIr),
        hasTeachMeta: Boolean(safeProgram.teachMeta),
        builtIn,
        updatedAt: builtIn ? "Built-in" : (safeProgram.updatedAt || "")
      };
    }
  }

  NS.ProgramStorage = ProgramStorage;
})();
