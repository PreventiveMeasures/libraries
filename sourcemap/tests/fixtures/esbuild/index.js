var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/side.js
var require_side = __commonJS({
  "src/side.js"() {
    globalThis.sideEffect = true;
  }
});

// node_modules/cjsdep/inner.js
var require_inner = __commonJS({
  "node_modules/cjsdep/inner.js"(exports) {
    exports.n = 7;
  }
});

// node_modules/cjsdep/index.js
var require_cjsdep = __commonJS({
  "node_modules/cjsdep/index.js"(exports, module) {
    var inner = require_inner();
    module.exports = { value: inner.n };
  }
});

// src/b.js
var b = () => 2;

// src/a.js
var a = () => b() + 1;

// src/index.js
var import_side = __toESM(require_side());

// node_modules/dep/util.js
var helper = () => 21;

// node_modules/dep/index.js
var fromDep = () => helper() * 2;

// src/index.js
var import_cjsdep = __toESM(require_cjsdep());
import { ext } from "ext";
function main() {
  return a() + fromDep() + import_cjsdep.default.value + ext();
}
export {
  main
};
//# sourceMappingURL=index.js.map
