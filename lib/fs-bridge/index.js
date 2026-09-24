const fs = require("fs");
const { isRemote, toRemote } = require("../classifier");

function apply(sftp, getRemoteCwd, cfg) {
  const { sftpCall, sftpExec, OP } = sftp;

  const ctx = {
    fs, isRemote, toRemote, sftpCall, sftpExec, OP, sftp, getRemoteCwd, cfg,
  };

  require("./cache").install(ctx);

  ctx.O = {};
  for (const k of [
    "existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync",
    "readdirSync", "mkdirSync", "unlinkSync", "accessSync", "renameSync",
    "rmSync", "copyFileSync", "appendFileSync", "realpathSync", "rmdirSync",
    "createReadStream", "createWriteStream", "watch", "watchFile",
    "readFile", "writeFile", "stat", "lstat", "readdir", "access", "mkdir",
    "unlink", "rename", "copyFile", "appendFile", "rm", "realpath",
    "open", "write", "close", "read", "fstat", "ftruncate", "fsync",
    "fchmod", "fchown", "futimes", "chown", "chmod", "utimes", "link",
    "symlink", "readlink", "truncate", "opendir", "cp",
  ]) {
    ctx.O[k] = fs[k];
  }

  require("./sync-ops").install(ctx);
  require("./async-ops").install(ctx);
  require("./promises").install(ctx);
  require("./streams").install(ctx);

  return {
    refreshProbesAsync: ctx.refreshProbesAsync,
    prefetchStartupExists: ctx.prefetchStartupExists,
  };
}

module.exports = { apply };
