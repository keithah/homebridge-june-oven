import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { JunePlatform } from './platform';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, JunePlatform);
};
