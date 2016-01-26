'use strict';

import destCopy from '../broccoli-dest-copy';
import compileWithTypescript, { INTERNAL_TYPINGS_PATH }
from '../broccoli-typescript';
var Funnel = require('broccoli-funnel');
import mergeTrees from '../broccoli-merge-trees';
var path = require('path');
import renderLodashTemplate from '../broccoli-lodash';
import replace from '../broccoli-replace';
var stew = require('broccoli-stew');

var projectRootDir = path.normalize(path.join(__dirname, '..', '..', '..', '..'));

module.exports = function makeNodeTree(projects, destinationPath) {
  // list of npm packages that this build will create
  var outputPackages = ['angular2', 'benchpress'];

  let srcTree = new Funnel('modules', {
    include: ['angular2/**'],
    exclude: [
      '**/e2e_test/**',
      'angular2/test/**',
      'angular2/examples/**',

      'angular2/src/testing/**',
      'angular2/testing.ts',
      'angular2/testing_internal.ts',
      'angular2/src/upgrade/**',
      'angular2/upgrade.ts',
      'angular2/platform/testing/**',
    ]
  });

  // Compile the sources and generate the @internal .d.ts
  let compiledSrcTreeWithInternals =
      compileTree(srcTree, true, ['angular2/manual_typings/globals.d.ts']);

  var testTree = new Funnel('modules', {
    include: [
      'angular2/manual_typings/**',
      'angular2/typings/**',

      'angular2/test/**',
      'benchpress/**',
      '**/e2e_test/**',
      'angular2/examples/**/*_spec.ts',

      'angular2/src/testing/**',
      'angular2/testing.ts',
      'angular2/testing_internal.ts',
      'angular2/src/upgrade/**',
      'angular2/upgrade.ts',
      'angular2/platform/testing/**',
    ],
    exclude: [
      // the following code and tests are not compatible with CJS/node environment
      'angular2/test/animate/**',
      'angular2/test/core/zone/**',
      'angular2/test/testing/fake_async_spec.ts',
      'angular2/test/testing/testing_public_spec.ts',
      'angular2/test/platform/xhr_impl_spec.ts',
      'angular2/test/platform/browser/**/*.ts',
      'angular2/test/common/forms/**',

      // we call browser's bootstrap
      'angular2/test/router/route_config_spec.ts',
      'angular2/test/router/integration/bootstrap_spec.ts',

      // we check the public api by importing angular2/angular2
      'angular2/test/symbol_inspector/**/*.ts',
      'angular2/test/public_api_spec.ts',

      'angular2/test/web_workers/worker/renderer_integration_spec.ts',

      'angular2/test/upgrade/**/*.ts',
      'angular1_router/**',
      'payload_tests/**'
    ]
  });

  // Compile the tests against the src @internal .d.ts
  let srcPrivateDeclarations =
      new Funnel(compiledSrcTreeWithInternals, {srcDir: INTERNAL_TYPINGS_PATH});

  testTree = mergeTrees([testTree, srcPrivateDeclarations]);

  let compiledTestTree = compileTree(testTree, false, [
    'angular2/typings/jasmine/jasmine.d.ts',
    'angular2/typings/angular-protractor/angular-protractor.d.ts',
    'angular2/manual_typings/globals.d.ts'
  ]);

  // Merge the compiled sources and tests
  let compiledSrcTree =
      new Funnel(compiledSrcTreeWithInternals, {exclude: [`${INTERNAL_TYPINGS_PATH}/**`]});

  let compiledTree = mergeTrees([compiledSrcTree, compiledTestTree]);

  // Now we add the LICENSE file into all the folders that will become npm packages
  outputPackages.forEach(function(destDir) {
    var license = new Funnel('.', {files: ['LICENSE'], destDir: destDir});
    // merge the test tree
    compiledTree = mergeTrees([compiledTree, license]);
  });

  // Get all docs and related assets and prepare them for js build
  var srcDocs = extractDocs(srcTree);
  var testDocs = extractDocs(testTree);

  var BASE_PACKAGE_JSON = require(path.join(projectRootDir, 'package.json'));
  var srcPkgJsons = extractPkgJsons(srcTree, BASE_PACKAGE_JSON);
  var testPkgJsons = extractPkgJsons(testTree, BASE_PACKAGE_JSON);

  var typingsTree = new Funnel(
      'modules',
      {include: ['angular2/typings/**/*.d.ts', 'angular2/manual_typings/*.d.ts'], destDir: '/'});

  var nodeTree =
      mergeTrees([compiledTree, srcDocs, testDocs, srcPkgJsons, testPkgJsons, typingsTree]);

  // Transform all tests to make them runnable in node
  nodeTree = replace(nodeTree, {
    files: ['**/test/**/*_spec.js'],
    patterns: [
      {
        match: /^/,
        replacement:
            () =>
                `var parse5Adapter = require('angular2/src/platform/server/parse5_adapter');\r\n` +
                `parse5Adapter.Parse5DomAdapter.makeCurrent();`
      },
      {match: /$/, replacement: (_, relativePath) => "\r\n main(); \r\n"}
    ]
  });

  // Prepend 'use strict' directive to all JS files.
  // See https://github.com/Microsoft/TypeScript/issues/3576
  nodeTree = replace(
      nodeTree, {files: ['**/*.js'], patterns: [{match: /^/, replacement: () => `'use strict';`}]});

  // Add a line to the end of our top-level .d.ts file.
  // This HACK for transitive typings is a workaround for
  // https://github.com/Microsoft/TypeScript/issues/5097
  //
  // This allows users to get our top-level dependencies like zone.d.ts
  // to appear when they compile against angular2.
  //
  // This carries the risk that the user brings their own copy of that file
  // (or any other symbols exported here) and they will get a compiler error
  // because of the duplicate definitions.
  // TODO(alexeagle): remove this when typescript releases a fix
  nodeTree = replace(nodeTree, {
    files: ['angular2/core.d.ts'],
    patterns: [{match: /$/, replacement: 'import "./manual_typings/globals-es6.d.ts";\r\n'}]
  });

  return destCopy(nodeTree, destinationPath);
};

function compileTree(tree, genInternalTypings, rootFilePaths: string[] = []) {
  return compileWithTypescript(tree, {
    // build pipeline options
    "rootFilePaths": rootFilePaths,
    "internalTypings": genInternalTypings,
    // tsc options
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "declaration": true,
    "stripInternal": true,
    "module": "commonjs",
    "moduleResolution": "classic",
    "noEmitOnError": true,
    "rootDir": ".",
    "inlineSourceMap": true,
    "inlineSources": true,
    "target": "es5"
  });
}

function extractDocs(tree) {
  var docs = new Funnel(tree, {include: ['**/*.md', '**/*.png'], exclude: ['**/*.dart.md']});
  return stew.rename(docs, 'README.js.md', 'README.md');
}

function extractPkgJsons(tree, BASE_PACKAGE_JSON) {
  // Generate shared package.json info
  var COMMON_PACKAGE_JSON = {
    version: BASE_PACKAGE_JSON.version,
    homepage: BASE_PACKAGE_JSON.homepage,
    bugs: BASE_PACKAGE_JSON.bugs,
    license: BASE_PACKAGE_JSON.license,
    repository: BASE_PACKAGE_JSON.repository,
    contributors: BASE_PACKAGE_JSON.contributors,
    dependencies: BASE_PACKAGE_JSON.dependencies,
    devDependencies: BASE_PACKAGE_JSON.devDependencies,
    defaultDevDependencies: {}
  };

  var packageJsons = new Funnel(tree, {include: ['**/package.json']});
  return renderLodashTemplate(packageJsons, {context: {'packageJson': COMMON_PACKAGE_JSON}});
}
