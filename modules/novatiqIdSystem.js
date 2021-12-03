/**
 * This module adds novatiqId to the User ID module
 * The {@link module:modules/userId} module is required
 * @module modules/novatiqIdSystem
 * @requires module:modules/userId
 */

import * as utils from '../src/utils.js';
import { ajax } from '../src/ajax.js';
import { submodule } from '../src/hook.js';

window.nlocvalue = 0;

/** @type {Submodule} */
export const novatiqIdSubmodule = {

  /**
   * used to link submodule with config
   * @type {string}
   */
  name: 'novatiq',

  /**
   * @function
   * @returns {novatiq: {snowflake: string}}
   */
  decode(novatiqId, config) {
    let responseObj = {
      novatiq: {
        snowflake: novatiqId
      }
    };
    return responseObj;
  },

  /**
   * performs action to obtain id and return a value in the callback's response argument
   * @function
   * @param {SubmoduleConfig} config
   * @returns {id: string}
   */
  getId(config) {
    function snowflakeId(placeholder) {
      return placeholder
        ? (placeholder ^ Math.random() * 16 >> placeholder / 4).toString(16)
        : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11 + 1e3).replace(/[018]/g, snowflakeId);
    }

    const configParams = config.params || {};
    const srcId = this.getSrcId(configParams);

    const novatiqId = snowflakeId();
    const url = 'https://spadsync.com/sync?sptoken=' + novatiqId;

    function getNlocvalue(cb){
      ajax(url,
        { success: onSuccess },
        undefined, { method: 'GET', withCredentials: false });
      function onSuccess(response, responseObj) {
        let syncrc;
        window.nlocvalue = 0;
        syncrc = responseObj.status;
        utils.logInfo('NOVATIQ Sync Response Code:' + syncrc);
        if (syncrc === 200) {
          window.nlocvalue = 1;
          utils.logInfo('nlocvalue param set to: ' + window.nlocvalue);
        } else if (syncrc === 204) {
          window.nlocvalue = 2;
          utils.logInfo('nlocvalue param set to: ' + window.nlocvalue);
        }
        cb({ 'id': novatiqId });
      }
    }

    utils.logInfo('NOVATIQ ssorigin param set to: ' + window.nlocvalue);
    utils.logInfo('NOVATIQ snowflake: ' + novatiqId);
    return {
      callback: (cb) => {
        getNlocvalue((id)=>{
          cb(id);
        })
      }
    }
  },

  getSrcId(configParams) {
    utils.logInfo('NOVATIQ Configured sourceid param: ' + configParams.sourceid);

    function isHex(str) {
      var a = parseInt(str, 16);
      return (a.toString(16) === str)
    }

    let srcId;
    if (typeof configParams.sourceid === 'undefined' || configParams.sourceid === null || configParams.sourceid === '') {
      srcId = '000';
      utils.logInfo('NOVATIQ sourceid param set to value 000 due to undefined parameter or missing value in config section');
    } else if (configParams.sourceid.length < 3 || configParams.sourceid.length > 3) {
      srcId = '001';
      utils.logInfo('NOVATIQ sourceid param set to value 001 due to wrong size in config section 3 chars max e.g. 1ab');
    } else if (isHex(configParams.sourceid) == false) {
      srcId = '002';
      utils.logInfo('NOVATIQ sourceid param set to value 002 due to wrong format in config section expecting hex value only');
    } else {
      srcId = configParams.sourceid;
    }
    return srcId
  }
};
submodule('userId', novatiqIdSubmodule);

// WEBPACK FOOTER //
// ./modules/novatiqIdSystem.js
