// e2e テスト用: モック GitLab に向けた設定を、本番と同じ DPAPI 暗号化で書き込む。
// 必ず Electron 経由で実行すること（safeStorage は Electron の中でしか動かない）。
//   node_modules/electron/dist/electron.exe scripts/mock-config.js \
//     --user-data-dir=<dir> --mock-url=http://127.0.0.1:PORT --mock-token=glpat-mock-token
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const arg = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(hit.indexOf('=') + 1) : '';
};

app.whenReady().then(async () => {
  const out = path.join(app.getPath('userData'), 'config.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const enc = await safeStorage.encryptStringAsync(arg('mock-token'));
  fs.writeFileSync(out, JSON.stringify({
    baseUrl: arg('mock-url'),
    intervalSec: 15,        // テストを速く進めるため最小値
    notify: true,
    insecure: false,
    autoStart: false,       // ログイン時起動には触らない
    tokenEnc: enc.toString('base64'),
  }, null, 2));
  console.log('wrote', out);
  // 非同期の暗号化キーが永続化される前に終了すると、次回起動時に復号へ失敗する。
  // （実際に確認した: 即 exit すると別プロセスで "Error while decrypting" になった）
  await new Promise(r => setTimeout(r, 2000));
  app.exit(0);
});
