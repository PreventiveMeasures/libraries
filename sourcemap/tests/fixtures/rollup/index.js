import { ext } from 'ext';

const b = () => 2;

const a = () => b() + 1;

globalThis.sideEffect = true;

const helper = () => 21;

const fromDep = () => helper() * 2;

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var inner = {};

var hasRequiredInner;

function requireInner () {
	if (hasRequiredInner) return inner;
	hasRequiredInner = 1;
	inner.n = 7;
	return inner;
}

var cjsdep;
var hasRequiredCjsdep;

function requireCjsdep () {
	if (hasRequiredCjsdep) return cjsdep;
	hasRequiredCjsdep = 1;
	const inner = requireInner();
	cjsdep = { value: inner.n };
	return cjsdep;
}

var cjsdepExports = requireCjsdep();
var cjs = /*@__PURE__*/getDefaultExportFromCjs(cjsdepExports);

function main() {
  return a() + fromDep() + cjs.value + ext()
}

export { main };
//# sourceMappingURL=index.js.map
