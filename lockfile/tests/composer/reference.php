<?php

// Composer itself as the reference, from the phar named first: what its
// version parser, its constraints, PHP's version_compare, sort and ksort,
// json_encode and its lockfile's loader and dumper make of each case, and
// whether `composer install` would install from a lockfile as it is, with
// and without require-dev, platform requirements left aside. reference.js
// runs it; each case is [kind, ...arguments], each result { value } or
// { error }.

declare(strict_types=1);

Phar::loadPhar($argv[1], 'composer.phar');
require 'phar://composer.phar/vendor/autoload.php';

use Composer\DependencyResolver\DefaultPolicy;
use Composer\DependencyResolver\Request;
use Composer\DependencyResolver\Solver;
use Composer\DependencyResolver\SolverProblemsException;
use Composer\Filter\PlatformRequirementFilter\PlatformRequirementFilterFactory;
use Composer\IO\NullIO;
use Composer\Json\JsonFile;
use Composer\Package\AliasPackage;
use Composer\Package\CompleteAliasPackage;
use Composer\Package\Dumper\ArrayDumper;
use Composer\Package\Loader\ArrayLoader;
use Composer\Package\Loader\ValidatingArrayLoader;
use Composer\Package\Version\VersionParser;
use Composer\Repository\LockArrayRepository;
use Composer\Repository\RepositorySet;
use Composer\Semver\Constraint\Constraint;

$parser = new VersionParser();

// Locker::getLockedRepository, of decoded lock data.
function locked(array $lock, bool $dev): LockArrayRepository
{
    $loader = new ArrayLoader(null, true);
    $repository = new LockArrayRepository();
    $packages = $dev ? array_merge($lock['packages'], $lock['packages-dev']) : $lock['packages'];
    $byName = [];
    foreach ($packages as $info) {
        $package = $loader->load($info);
        $repository->addPackage($package);
        $byName[$package->getName()] = $package;
        if ($package instanceof AliasPackage) {
            $byName[$package->getAliasOf()->getName()] = $package->getAliasOf();
        }
    }
    foreach ($lock['aliases'] as $alias) {
        if (isset($byName[$alias['package']])) {
            $root = new CompleteAliasPackage($byName[$alias['package']], $alias['alias_normalized'], $alias['alias']);
            $root->setRootPackageAlias(true);
            $repository->addPackage($root);
        }
    }

    return $repository;
}

// What Installer::doInstall checks before it installs from a lockfile:
// every locked package fixed, the platform ignored, and the solver asked
// for no change.
function install(array $lock, bool $dev): string
{
    $repository = locked($lock, $dev);
    $filter = PlatformRequirementFilterFactory::ignoreAll();
    $requires = [];
    foreach ($repository->getPackages() as $package) {
        $constraint = new Constraint('=', $package->getVersion());
        $constraint->setPrettyString($package->getPrettyVersion());
        $requires[$package->getName()] = $constraint;
    }
    $set = new RepositorySet($lock['minimum-stability'], (array) $lock['stability-flags'], [], [], $requires);
    $set->addRepository($repository);
    $request = new Request($repository);
    foreach ($repository->getPackages() as $package) {
        $request->fixLockedPackage($package);
    }
    $pool = $set->createPool($request, new NullIO());
    try {
        $transaction = (new Solver(new DefaultPolicy(false, false), $pool, new NullIO()))->solve($request, $filter);
    } catch (SolverProblemsException $e) {
        return 'problems: '.trim($e->getPrettyString($set, $request, $pool, false));
    }

    return count($transaction->getOperations()) === 0 ? 'ok' : 'operations';
}

// Locker::lockPackages of one package, loaded as Composer loads it.
function dumped(array $entry): string
{
    $package = (new ArrayLoader(null, true))->load($entry);
    if ($package instanceof AliasPackage) {
        $package = $package->getAliasOf();
    }
    $spec = (new ArrayDumper())->dump($package);
    unset($spec['version_normalized']);
    $time = $spec['time'] ?? null;
    unset($spec['time']);
    if ($time !== null) {
        $spec['time'] = $time;
    }
    unset($spec['installation-source']);

    return JsonFile::encode($spec);
}

$kinds = [
    'version' => fn () => Composer\Composer::VERSION,
    'normalize' => fn ($text) => $parser->normalize($text),
    'constraints' => fn ($text) => (string) $parser->parseConstraints($text),
    'matches' => fn ($a, $b) => $parser->parseConstraints($a)->matches($parser->parseConstraints($b)),
    'allows' => fn ($text, $version) => $parser->parseConstraints($text)->matches(new Constraint('==', $version)),
    'compare' => fn ($a, $b) => version_compare($a, $b),
    'stability' => fn ($text) => VersionParser::parseStability($text),
    'branch' => fn ($text) => $parser->normalizeBranch($text),
    'prefix' => fn ($text) => $parser->parseNumericAliasPrefix($text),
    'branchAlias' => fn ($config) => (new ArrayLoader())->getBranchAlias(json_decode($config, true)),
    'ksort' => function ($keys) {
        $array = array_fill_keys($keys, true);
        ksort($array);

        return array_map('strval', array_keys($array));
    },
    'sort' => function ($values) {
        sort($values);

        return $values;
    },
    'float' => fn ($text) => json_encode(json_decode($text)),
    // The file as Composer writes back what it decodes of it, in the
    // indentation it finds, as 2.6 and later do; objects stay objects.
    'json' => function ($text) {
        $data = json_decode($text, false, 512, JSON_THROW_ON_ERROR);

        $indent = method_exists(JsonFile::class, 'detectIndenting') ? JsonFile::detectIndenting($text) : '    ';

        return JsonFile::encode($data, 448, $indent)."\n" === $text;
    },
    // composer.json as Composer decodes it and hashes it.
    'decode' => fn ($text) => json_encode(JsonFile::parseJson($text), JSON_THROW_ON_ERROR),
    'hash' => fn ($text) => Composer\Package\Locker::getContentHash($text),
    // composer.json as Factory holds it to before it loads it, by its
    // schema, and as RootPackageLoader holds its name, its version, and the
    // names it links to, the root's own not among its requirements.
    'root' => function ($text) use ($parser) {
        $data = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        JsonFile::validateJsonSchema('composer.json', $data, JsonFile::LAX_SCHEMA);
        $config = json_decode($text, true);
        if (isset($config['name']) && ValidatingArrayLoader::hasPackageNamingError($config['name']) !== null) {
            throw new RuntimeException('name');
        }
        if (isset($config['version'])) {
            $parser->normalize($config['version']);
        }
        foreach (['require', 'require-dev', 'conflict', 'provide', 'replace'] as $type) {
            foreach ($config[$type] ?? [] as $target => $constraint) {
                if (ValidatingArrayLoader::hasPackageNamingError((string) $target, true) !== null) {
                    throw new RuntimeException($type);
                }
                if (in_array($type, ['require', 'require-dev'], true) && strtolower((string) $target) === ($config['name'] ?? '__root__')) {
                    throw new RuntimeException('itself');
                }
            }
        }

        return true;
    },
    'package' => function ($text) {
        $entry = json_decode($text, true, 512, JSON_THROW_ON_ERROR);

        return dumped($entry) === JsonFile::encode($entry);
    },
    'install' => function ($text) {
        $lock = json_decode($text, true, 512, JSON_THROW_ON_ERROR);

        return [install($lock, true), install($lock, false)];
    },
];

$results = [];
foreach (json_decode(stream_get_contents(STDIN), true) as $case) {
    $kind = array_shift($case);
    $args = $case;
    try {
        $results[] = ['value' => $kinds[$kind](...$args)];
    } catch (\Throwable $e) {
        $results[] = ['error' => get_class($e)];
    }
}
echo json_encode($results, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
