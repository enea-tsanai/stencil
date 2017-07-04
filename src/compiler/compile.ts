import { access, isTsSourceFile, readFile, writeFiles } from './util';
import { CompilerConfig, CompileResults, Logger, StencilSystem, WorkerBuildContext } from './interfaces';
import { generateManifest } from './manifest';
import { transpileWorker } from './transpile';
import { WorkerManager } from './worker-manager';


export function compile(sys: StencilSystem, logger: Logger, workerManager: WorkerManager, compilerConfig: CompilerConfig) {
  // within MAIN thread
  const timeSpan = logger.createTimeSpan(`compile started`);

  logger.debug(`compile, include: ${compilerConfig.include}`);
  logger.debug(`compile, outDir: ${compilerConfig.compilerOptions.outDir}`);

  compilerConfig.include = compilerConfig.include || [];

  const filesToWrite = new Map<string, string>();

  if (!compilerConfig.exclude) {
    compilerConfig.exclude = ['node_modules', 'bower_components'];
  }

  const compileResults: CompileResults = {
    moduleFiles: {},
    diagnostics: [],
    includedSassFiles: [],
    manifest: {}
  };

  return Promise.all(compilerConfig.include.map(includePath => {
    return access(sys, includePath).then(pathExists => {
      if (!pathExists) {
        return Promise.resolve(null);
      }
      return compileDirectory(sys, logger, includePath, compilerConfig, workerManager, compileResults, filesToWrite);
    });

  })).then(() => {
    if (compileResults.diagnostics && compileResults.diagnostics.length) {
      compileResults.diagnostics.forEach(d => {
        logger[d.level](d.msg);
        d.stack && logger.debug(d.stack);
      });

    } else {
      compileResults.manifest = generateManifest(sys, logger, compilerConfig, compileResults, filesToWrite);
    }

  }).then(() => {
    return copySourceSassFilesToDest(sys, compilerConfig, compileResults.includedSassFiles, filesToWrite);

  }).then(() => {
    return writeFiles(sys, filesToWrite);

  }).catch(err => {
    logger.error(err);
    err.stack && logger.debug(err.stack);

  }).then(() => {
    timeSpan.finish(`compile finished`);
    return compileResults;
  });
}


function compileDirectory(sys: StencilSystem, logger: Logger, dir: string, compilerConfig: CompilerConfig, workerManager: WorkerManager, compileResults: CompileResults, filesToWrite: Map<string, string>): Promise<any> {
  // within MAIN thread
  return new Promise(resolve => {
    // loop through this directory and sub directories looking for
    // files that need to be transpiled
    logger.debug(`compileDirectory: ${dir}`);

    sys.fs.readdir(dir, (err, files) => {
      if (err) {
        compileResults.diagnostics.push({
          msg: `compileDirectory, fs.readdir: ${dir}, ${err}`,
          level: 'error'
        });
        resolve();
        return;
      }

      const promises: Promise<any>[] = [];

      files.forEach(dirItem => {
        // let's loop through each of the files we've found so far
        const readPath = sys.path.join(dir, dirItem);

        if (!isValidDirectory(compilerConfig, readPath)) {
          // don't bother continuing for invalid directories
          return;
        }

        promises.push(new Promise(resolve => {

          sys.fs.stat(readPath, (err, stats) => {
            if (err) {
              // derp, not sure what's up here, let's just print out the error
              compileResults.diagnostics.push({
                msg: `compileDirectory, fs.stat: ${readPath}, ${err}`,
                level: 'error'
              });
              resolve();

            } else if (stats.isDirectory()) {
              // looks like it's yet another directory
              // let's keep drilling down
              compileDirectory(sys, logger, readPath, compilerConfig, workerManager, compileResults, filesToWrite).then(() => {
                resolve();
              });

            } else if (isTsSourceFile(readPath)) {
              // woot! we found a typescript file that needs to be transpiled
              // let's send this over to our worker manager who can
              // then assign a worker to this exact file
              compileFile(workerManager, compilerConfig, readPath, compileResults, filesToWrite).then(() => {
                resolve();
              });

            } else {
              // idk, don't care, just resolve
              resolve();
            }
          });

        }));

      });

      Promise.all(promises).then(() => {
        // cool, all the recursive scan directories have finished
        // let this resolve and start bubbling up the resolves
        resolve();
      });
    });

  });
}


function compileFile(workerManager: WorkerManager, compilerConfig: CompilerConfig, filePath: string, compileResults: CompileResults, filesToWrite: Map<string, string>) {
  // within MAIN thread
  // let's send this over to our worker manager who can
  // then assign a worker to this exact file
  return workerManager.compileFile(compilerConfig, filePath).then(compileWorkerResult => {
    // awesome, our worker friend finished the job and responded
    // let's resolve and let the main thread take it from here
    if (compileWorkerResult.moduleFiles) {
      Object.keys(compileWorkerResult.moduleFiles).forEach(filePath => {
        compileResults.moduleFiles[filePath] = compileWorkerResult.moduleFiles[filePath];

        if (compilerConfig.writeCompiledToDisk) {
          filesToWrite.set(
            compileResults.moduleFiles[filePath].jsFilePath,
            compileResults.moduleFiles[filePath].jsText
          );
        }
      });
    }

    if (compileWorkerResult.diagnostics) {
      compileResults.diagnostics = compileResults.diagnostics.concat(compileWorkerResult.diagnostics);
    }

    if (compileWorkerResult.includedSassFiles) {
      compileWorkerResult.includedSassFiles.forEach(includedSassFile => {
        if (compileResults.includedSassFiles.indexOf(includedSassFile) === -1) {
          compileResults.includedSassFiles.push(includedSassFile);
        }
      });
    }
  });
}


export function compileFileWorker(sys: StencilSystem, logger: Logger, ctx: WorkerBuildContext, compilerConfig: CompilerConfig, filePath: string) {
  // within WORKER thread
  return transpileWorker(sys, logger, ctx, compilerConfig, filePath)
    .catch(err => {
      const compileResult: CompileResults = {
        diagnostics: [{
          msg: err.toString(),
          level: 'error',
          stack: err.stack
        }]
      };
      return compileResult;
    });
}


function copySourceSassFilesToDest(sys: StencilSystem, compilerConfig: CompilerConfig, includedSassFiles: string[], filesToWrite: Map<string, string>): Promise<any> {
  if (!compilerConfig.writeCompiledToDisk) {
    return Promise.resolve();
  }

  return Promise.all(includedSassFiles.map(sassSrcPath => {
    return readFile(sys, sassSrcPath).then(sassSrcText => {
      const includeDir = compilerConfig.include.find(includeDir => sassSrcPath.indexOf(includeDir) === 0);
      let sassDestPath: string;

      if (includeDir) {
        sassDestPath = sys.path.join(
          compilerConfig.compilerOptions.outDir,
          sys.path.relative(includeDir, sassSrcPath)
        );

      } else {
        sassDestPath = sys.path.join(
          compilerConfig.compilerOptions.rootDir,
          sys.path.relative(compilerConfig.compilerOptions.rootDir, sassSrcPath)
        );
      }

      filesToWrite.set(sassDestPath, sassSrcText);
    });
  }));
}


function isValidDirectory(config: CompilerConfig, filePath: string) {
  for (var i = 0; i < config.exclude.length; i++) {
    if (filePath.indexOf(config.exclude[i]) > -1) {
      return false;
    }
  }
  return true;
}
