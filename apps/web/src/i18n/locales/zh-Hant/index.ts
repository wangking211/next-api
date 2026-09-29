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
import groups from './groups.json';

/** 繁體中文（台灣用語）——键集必须与 zh-CN 完全一致（scripts/i18n-check.mjs 校验） */
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
  ...groups,
};
