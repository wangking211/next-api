import common from './common.json';
import api from './api.json';
import layout from './layout.json';
import landing from './landing.json';
import auth from './auth.json';
import dashboard from './dashboard.json';
import keys from './keys.json';
import channels from './channels.json';
import models from './models.json';
import logs from './logs.json';
import usage from './usage.json';
import billing from './billing.json';
import agent from './agent.json';
import admin from './admin.json';

/** English — key set must mirror zh-CN exactly (verified by scripts/i18n-check.mjs) */
export default {
  ...common,
  ...api,
  ...layout,
  ...landing,
  ...auth,
  ...dashboard,
  ...keys,
  ...channels,
  ...models,
  ...logs,
  ...usage,
  ...billing,
  ...agent,
  ...admin,
};
