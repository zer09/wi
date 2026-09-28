import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require=createRequire(import.meta.url);
const root=dirname(require.resolve('playwright-core/package.json'));
const {debug}=require(join(root,'lib/utilsBundle.js'));

// Call before our own launch, before credentials exist, and before CDP attachment.
export function reconnectPrivacy(chromium,use,env=process.env) {
  const fail=category => {throw Object.assign(new Error('read reconnect privacy guard rejected'),{privacy:category});};
  for(const key of ['DEBUG','DEBUG_FILE','PWDEBUG','NODE_OPTIONS','PW_TEST_DEBUG_PROTOCOL','PW_TEST_CONNECT_WS_ENDPOINT',
    'PW_TEST_CONNECT_HEADERS','PW_TEST_SERVER_WS_ENDPOINT','CHROME_LOG_FILE','SSLKEYLOGFILE'])if(env[key])fail('environment');
  if(['pw:api','pw:protocol','pw:browser','pw:channel'].some(name => debug.enabled(name)))fail('debug');
  for(const options of [use,chromium?._playwright?._defaultLaunchOptions,chromium?._playwright?._defaultContextOptions]) {
    if(!options)continue;
    if(options.logger || options.recordHar || options.recordVideo || options.launchOptions || options.connectOptions
      || options.args || options.executablePath || options.env || (options === use && options.tracesDir) || options.artifactsDir)fail('options');
    for(const key of ['trace','screenshot','video'])if(options[key] !== undefined && options[key] !== 'off')fail('capture');
  }
  if(chromium?._logger || chromium?._connection?._logger || chromium?._connection?._protocolLogger)fail('logger');
}
