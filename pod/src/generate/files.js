// What a spec's FileAccessor makes of a pod's files, as pathlist.js lists them. Paths are from the pod's directory.

import { extname, posix } from 'node:path'

import { glob } from '../pathlist.js'

// Xcodeproj's header extensions, and FileAccessor's source extensions.
export const HEADERS = ['.h', '.hh', '.hpp', '.ipp', '.tpp', '.hxx', '.def', '.inl', '.inc']
export const SOURCES = ['.m', '.mm', '.i', '.c', '.cc', '.cxx', '.cpp', '.c++', '.swift', ...HEADERS]
const DIR_PATTERNS = { source_files: `*{${SOURCES.join(',')}}`, public_header_files: `*{${HEADERS.join(',')}}` }

const unique = (paths) => [...new Set(paths)]
const isHeader = (path) => HEADERS.includes(extname(path))

// A spec's FileAccessor for `consumer`, spec.js's consumerOf.
export function accessorOf(list, consumer) {
  const exclude = consumer.exclude_files
  const paths = (attribute, includeDirs = false) => unique(glob(list, consumer[attribute], { exclude, dirPattern: DIR_PATTERNS[attribute], includeDirs }))
  const sourceFiles = paths('source_files')
  const headers = sourceFiles.filter(isHeader)
  const publicGiven = paths('public_header_files')
  const projectHeaders = paths('project_header_files')
  const privateHeaders = paths('private_header_files')
  const hidden = new Set([...projectHeaders, ...privateHeaders])
  const vendoredFrameworks = paths('vendored_frameworks', true)
  const requiresArc = consumer.requires_arc
  const arcSourceFiles = requiresArc === true ? sourceFiles : requiresArc === false ? [] : unique(glob(list, [requiresArc].flat(), { exclude })).filter((path) => sourceFiles.includes(path))
  return {
    spec: consumer.spec,
    consumer,
    list,
    sourceFiles,
    headers,
    publicHeaders: (publicGiven.length === 0 ? headers : publicGiven).filter((path) => !hidden.has(path)),
    projectHeaders,
    privateHeaders,
    arcSourceFiles,
    resources: paths('resources', true),
    resourceBundles: Object.fromEntries(Object.entries(consumer.resource_bundles).map(([name, patterns]) => [name, unique(glob(list, patterns, { exclude, includeDirs: true }))])),
    vendoredFrameworks,
    vendoredXcframeworks: vendoredFrameworks.filter((path) => extname(path) === '.xcframework'),
    vendoredLibraries: paths('vendored_libraries'),
    moduleMap: typeof consumer.module_map === 'string' ? consumer.module_map : undefined,
    prefixHeader: typeof consumer.prefix_header_file === 'string' ? consumer.prefix_header_file : undefined,
  }
}

// FileAccessor#license: the root's `license.file` where it is there, else the first `licen{c,s}e{*,.*}`.
export function licenseOf(list, license) {
  if (typeof license.file === 'string' && list.files.includes(license.file)) return license.file
  return glob(list, ['licen{c,s}e{*,.*}'])[0]
}

// FileAccessor#developer_files of a local pod.
export function developerFiles(target) {
  const { list } = target
  const podspecs = glob(list, ['*.{podspec,podspec.json}'])
  const own = target.accessors.flatMap((accessor) => [accessor.moduleMap, accessor.prefixHeader])
  const license = licenseOf(list, target.root.license)
  const rest = podspecs.length <= 1 ? [license, glob(list, ['readme{*,.*}'])[0], ...podspecs, ...glob(list, ['doc{s}{*,.*}/**/*'])] : [podspecs.find((path) => posix.basename(path, posix.extname(path)) === target.name), license]
  return [...new Set([...own, ...rest].filter((path) => path !== undefined))].sort()
}
