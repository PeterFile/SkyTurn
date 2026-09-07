import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import vm from "node:vm";

export function createSourceModuleLoader({
  typescript,
  globals = {},
  mocks = new Map(),
  loadExternal = (specifier, importer) => createRequire(importer)(specifier),
}) {
  const cache = new Map();

  function load(filename, { sourceSuffix = "" } = {}) {
    return loadSource(resolve(filename), sourceSuffix);
  }

  function loadSource(filename, sourceSuffix = "") {
    const cached = cache.get(filename);
    if (cached) return cached.exports;
    if (!isFile(filename)) {
      throw new Error(`Cannot load source module "${filename}": file does not exist.`);
    }

    const module = { exports: {} };
    cache.set(filename, module);
    try {
      const source = `${readFileSync(filename, "utf8")}${sourceSuffix}`;
      const output = typescript.transpileModule(source, {
        compilerOptions: {
          module: typescript.ModuleKind.CommonJS,
          target: typescript.ScriptTarget.ES2022,
        },
        fileName: filename,
      }).outputText;
      vm.runInNewContext(output, {
        ...globals,
        module,
        exports: module.exports,
        require: (specifier) => loadSpecifier(filename, specifier),
        __dirname: dirname(filename),
        __filename: filename,
      }, { filename });
      return module.exports;
    } catch (error) {
      cache.delete(filename);
      throw error;
    }
  }

  function loadSpecifier(importer, specifier) {
    if (!isLocalSpecifier(specifier)) {
      return mocks.has(specifier)
        ? mocks.get(specifier)
        : loadExternal(specifier, importer);
    }

    for (const candidate of sourceCandidates(importer, specifier)) {
      if (mocks.has(candidate)) return mocks.get(candidate);
      if (isFile(candidate)) return loadSource(candidate);
    }
    throw new Error(
      `Cannot load local source module "${specifier}" imported from "${importer}": no matching source file.`,
    );
  }

  return { load };
}

function isLocalSpecifier(specifier) {
  return specifier === "."
    || specifier === ".."
    || specifier.startsWith("./")
    || specifier.startsWith("../");
}

function sourceCandidates(importer, specifier) {
  const requested = resolve(dirname(importer), specifier);
  const extension = extname(requested);
  if (extension === ".js") {
    return [requested, `${requested.slice(0, -3)}.ts`];
  }
  if (extension === "") {
    return [requested, `${requested}.ts`, `${requested}.js`];
  }
  return [requested];
}

function isFile(filename) {
  try {
    return statSync(filename).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}
