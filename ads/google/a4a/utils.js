/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Services} from '../../../src/services';
import {buildUrl} from './url-builder';
import {makeCorrelator} from '../correlator';
import {isCanary} from '../../../src/experiments';
import {getOrCreateAdCid} from '../../../src/ad-cid';
import {dev} from '../../../src/log';
import {dict} from '../../../src/utils/object';
import {getMode} from '../../../src/mode';
import {parseUrl} from '../../../src/url';
import {parseJson} from '../../../src/json';
import {DomFingerprint} from '../../../src/utils/dom-fingerprint';
import {
  isExperimentOn,
  toggleExperiment,
} from '../../../src/experiments';

/** @type {string}  */
const AMP_ANALYTICS_HEADER = 'X-AmpAnalytics';

/** @const {number} */
const MAX_URL_LENGTH = 4096;

/** @enum {string} */
const AmpAdImplementation = {
  AMP_AD_XHR_TO_IFRAME: '2',
  AMP_AD_XHR_TO_IFRAME_OR_AMP: '3',
};

/** @const {!Object} */
export const ValidAdContainerTypes = {
  'AMP-CAROUSEL': 'ac',
  'AMP-FX-FLYING-CARPET': 'fc',
  'AMP-LIGHTBOX': 'lb',
  'AMP-STICKY-AD': 'sa',
};

/** @const {string} */
export const QQID_HEADER = 'X-QQID';

/**
 * Element attribute that stores experiment IDs.
 *
 * Note: This attribute should be used only for tracking experimental
 * implementations of AMP tags, e.g., by AMPHTML implementors.  It should not be
 * added by a publisher page.
 *
 * @const {!string}
 * @visibleForTesting
 */
export const EXPERIMENT_ATTRIBUTE = 'data-experiment-id';

/** @typedef {{urls: !Array<string>}}
 */
export let AmpAnalyticsConfigDef;

/**
 * @const {!./url-builder.QueryParameterDef}
 * @visibleForTesting
 */
export const TRUNCATION_PARAM = {name: 'trunc', value: '1'};

/**
 * Check whether Google Ads supports the A4A rendering pathway is valid for the
 * environment by ensuring native crypto support and page originated in the
 * the {@code cdn.ampproject.org} CDN <em>or</em> we must be running in local
 * dev mode.
 *
 * @param {!Window} win  Host window for the ad.
 * @returns {boolean}  Whether Google Ads should attempt to render via the A4A
 *   pathway.
 */
export function isGoogleAdsA4AValidEnvironment(win) {
  const supportsNativeCrypto = win.crypto &&
      (win.crypto.subtle || win.crypto.webkitSubtle);
  const googleCdnProxyRegex =
      /^https:\/\/([a-zA-Z0-9_-]+\.)?cdn\.ampproject\.org/;
  return supportsNativeCrypto &&
      (googleCdnProxyRegex.test(win.location.origin) || getMode(win).localDev ||
       getMode(win).test);
}

/**
 * @param {!AMP.BaseElement} ampElement The element on whose lifecycle this
 *    reporter will be reporting.
 * @return {boolean} whether reporting is enabled for this element
 */
export function isReportingEnabled(ampElement) {
  // Carve-outs: We only want to enable profiling pingbacks when:
  //   - The ad is from one of the Google networks (AdSense or Doubleclick).
  //   - The ad slot is in the A4A-vs-3p amp-ad control branch (either via
  //     internal, client-side selection or via external, Google Search
  //     selection).
  //   - We haven't turned off profiling via the rate controls in
  //     build-system/global-config/{canary,prod}-config.json
  // If any of those fail, we use the `BaseLifecycleReporter`, which is a
  // a no-op (sends no pings).
  const type = ampElement.element.getAttribute('type');
  const win = ampElement.win;
  const experimentName = 'a4aProfilingRate';
  // In local dev mode, neither the canary nor prod config files is available,
  // so manually set the profiling rate, for testing/dev.
  if (getMode().localDev) {
    toggleExperiment(win, experimentName, true, true);
  }
  return (type == 'doubleclick' || type == 'adsense') &&
      isExperimentOn(win, experimentName);
}

/**
 * Has side-effect of incrementing ifi counter on window.
 * @param {!../../../extensions/amp-a4a/0.1/amp-a4a.AmpA4A} a4a
 * @param {!Array<string>=} opt_experimentIds Any experiments IDs (in addition
 *     to those specified on the ad element) that should be included in the
 *     request.
 * @return {!Object<string,null|number|string>} block level parameters
 */
export function googleBlockParameters(a4a, opt_experimentIds) {
  const adElement = a4a.element;
  const win = a4a.win;
  const slotRect = a4a.getPageLayoutBox();
  const iframeDepth = iframeNestingDepth(win);
  const enclosingContainers = getEnclosingContainerTypes(adElement);
  const pfx = enclosingContainers.includes(
      ValidAdContainerTypes['AMP-FX-FLYING-CARPET']) ||
      enclosingContainers.includes(ValidAdContainerTypes['AMP-STICKY-AD']);
  let eids = adElement.getAttribute('data-experiment-id');
  if (opt_experimentIds) {
    eids = mergeExperimentIds(opt_experimentIds, eids);
  }
  return {
    'adf': DomFingerprint.generate(adElement),
    'nhd': iframeDepth,
    'eid': eids,
    'adx': slotRect.left,
    'ady': slotRect.top,
    'oid': '2',
    'pfx': pfx ? '1' : '0',
    'act': enclosingContainers.length ? enclosingContainers.join() : null,
  };
}

/**
 * @param {!Window} win
 * @param {string} type matching typing attribute.
 * @param {!function(!Element):string} groupFn
 * @return {!Promise<!Object<string,!Array<!Promise<!../../../src/base-element.BaseElement>>>>}
 */
export function groupAmpAdsByType(win, type, groupFn) {
  return Services.resourcesForDoc(win.document).getMeasuredResources(win,
      r => r.element.tagName == 'AMP-AD' &&
        r.element.getAttribute('type') == type)
      .then(resources => {
        const result = {};
        resources.forEach(r => {
          const groupId = groupFn(r.element);
          (result[groupId] || (result[groupId] = [])).push(r.element.getImpl());
        });
        return result;
      });
}

/**
 * @param {!Window} win
 * @param {!Node|!../../../src/service/ampdoc-impl.AmpDoc} nodeOrDoc
 * @param {number} startTime
 * @param {string=} output default is 'html'
 * @return {!Promise<!Object<string,null|number|string>>}
 */
export function googlePageParameters(
    win, nodeOrDoc, startTime, output = 'html') {
  const referrerPromise = Services.viewerForDoc(nodeOrDoc).getReferrerUrl();
  return getOrCreateAdCid(nodeOrDoc, 'AMP_ECID_GOOGLE', '_ga')
      .then(clientId => referrerPromise.then(referrer => {
        const documentInfo = Services.documentInfoForDoc(nodeOrDoc);
        // Read by GPT for GA/GPT integration.
        win.gaGlobal = win.gaGlobal ||
        {cid: clientId, hid: documentInfo.pageViewId};
        const screen = win.screen;
        const viewport = Services.viewportForDoc(nodeOrDoc);
        const viewportRect = viewport.getRect();
        const viewportSize = viewport.getSize();
        return {
          'is_amp': AmpAdImplementation.AMP_AD_XHR_TO_IFRAME_OR_AMP,
          'amp_v': '$internalRuntimeVersion$',
          'd_imp': '1',
          'c': getCorrelator(win, clientId, nodeOrDoc),
          'dt': startTime,
          output,
          'biw': viewportRect.width,
          'bih': viewportRect.height,
          'u_aw': screen ? screen.availWidth : null,
          'u_ah': screen ? screen.availHeight : null,
          'u_cd': screen ? screen.colorDepth : null,
          'u_w': screen ? screen.width : null,
          'u_h': screen ? screen.height : null,
          'u_tz': -new Date().getTimezoneOffset(),
          'u_his': getHistoryLength(win),
          'isw': win != win.top ? viewportSize.width : null,
          'ish': win != win.top ? viewportSize.height : null,
          'art': isCanary(win) ? '2' : null,
          'url': documentInfo.canonicalUrl,
          'top': win != win.top ? topWindowUrlOrDomain(win) : null,
          'loc': win.location.href == documentInfo.canonicalUrl ?
          null : win.location.href,
          'ref': referrer,
        };
      }));
}

/**
 * @param {!../../../extensions/amp-a4a/0.1/amp-a4a.AmpA4A} a4a
 * @param {string} baseUrl
 * @param {number} startTime
 * @param {!Object<string,null|number|string>} parameters
 * @param {!Array<string>=} opt_experimentIds Any experiments IDs (in addition
 *     to those specified on the ad element) that should be included in the
 *     request.
 * @return {!Promise<string>}
 */
export function googleAdUrl(
    a4a, baseUrl, startTime, parameters, opt_experimentIds) {
  // TODO: Maybe add checks in case these promises fail.
  const blockLevelParameters = googleBlockParameters(a4a, opt_experimentIds);
  return googlePageParameters(a4a.win, a4a.getAmpDoc(), startTime)
      .then(pageLevelParameters => {
        Object.assign(parameters, blockLevelParameters, pageLevelParameters);
        return truncAndTimeUrl(baseUrl, parameters, startTime);
      });
}

/**
 * @param {string} baseUrl
 * @param {!Object<string,null|number|string>} parameters
 * @param {number} startTime
 * @return {string}
 */
export function truncAndTimeUrl(baseUrl, parameters, startTime) {
  return buildUrl(
      baseUrl, parameters, MAX_URL_LENGTH - 10, TRUNCATION_PARAM)
    + '&dtd=' + elapsedTimeWithCeiling(Date.now(), startTime);
}

/**
 * @param {!Window} win
 * @return {number}
 */
function iframeNestingDepth(win) {
  let w = win;
  let depth = 0;
  while (w != w.parent && depth < 100) {
    w = w.parent;
    depth++;
  }
  dev().assert(w == win.top);
  return depth;
}

/**
 * @param {!Window} win
 * @return {number}
 */
function getHistoryLength(win) {
  // We have seen cases where accessing history length causes errors.
  try {
    return win.history.length;
  } catch (e) {
    return 0;
  }
}

/**
 * @param {!Window} win
 * @return {?string}
 */
function topWindowUrlOrDomain(win) {
  const ancestorOrigins = win.location.ancestorOrigins;
  if (ancestorOrigins) {
    const origin = win.location.origin;
    const topOrigin = ancestorOrigins[ancestorOrigins.length - 1];
    if (origin == topOrigin) {
      return win.top.location.hostname;
    }
    const secondFromTop = secondWindowFromTop(win);
    if (secondFromTop == win ||
        origin == ancestorOrigins[ancestorOrigins.length - 2]) {
      return parseUrl(secondFromTop./*OK*/document.referrer).hostname;
    }
    return parseUrl(topOrigin).hostname;
  } else {
    try {
      return win.top.location.hostname;
    } catch (e) {}
    const secondFromTop = secondWindowFromTop(win);
    try {
      return parseUrl(secondFromTop./*OK*/document.referrer).hostname;
    } catch (e) {}
    return null;
  }
}

/**
 * @param {!Window} win
 * @return {!Window}
 */
function secondWindowFromTop(win) {
  let secondFromTop = win;
  let depth = 0;
  while (secondFromTop.parent != secondFromTop.parent.parent &&
        depth < 100) {
    secondFromTop = secondFromTop.parent;
    depth++;
  }
  dev().assert(secondFromTop.parent == win.top);
  return secondFromTop;
}

/**
 * @param {number} time
 * @param {number} start
 * @return {(number|string)}
 */
function elapsedTimeWithCeiling(time, start) {
  const duration = time - start;
  if (duration >= 1e6) {
    return 'M';
  } else if (duration >= 0) {
    return duration;
  }
  return '-M';
}

/**
 * @param {!Window} win
 * @param {string=} opt_cid
 * @param {(!Node|!../../../src/service/ampdoc-impl.AmpDoc)=} opt_nodeOrDoc
 * @return {number} The correlator.
 */
export function getCorrelator(win, opt_cid, opt_nodeOrDoc) {
  if (!win.ampAdPageCorrelator) {
    win.ampAdPageCorrelator = makeCorrelator(
        opt_cid,
        Services.documentInfoForDoc(opt_nodeOrDoc || win.document).pageViewId);
  }
  return win.ampAdPageCorrelator;
}

/**
 * Collect additional dimensions for the brdim parameter.
 * @param {!Window} win The window for which we read the browser dimensions.
 * @param {{width: number, height: number}|null} viewportSize
 * @return {string}
 * @visibleForTesting
 */
export function additionalDimensions(win, viewportSize) {
  // Some browsers throw errors on some of these.
  let screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight;
  try {
    screenX = win.screenX;
    screenY = win.screenY;
  } catch (e) {}
  try {
    outerWidth = win.outerWidth;
    outerHeight = win.outerHeight;
  } catch (e) {}
  try {
    innerWidth = viewportSize.width;
    innerHeight = viewportSize.height;
  } catch (e) {}
  return [win.screenLeft,
    win.screenTop,
    screenX,
    screenY,
    win.screen ? win.screen.availWidth : undefined,
    win.screen ? win.screen.availTop : undefined,
    outerWidth,
    outerHeight,
    innerWidth,
    innerHeight].join();
};

/**
 * Extracts configuration used to build amp-analytics element for active view.
 *
 * @param {!../../../extensions/amp-a4a/0.1/amp-a4a.AmpA4A} a4a
 * @param {!../../../src/service/xhr-impl.FetchResponseHeaders} responseHeaders
 *   XHR service FetchResponseHeaders object containing the response
 *   headers.
 * @return {?JsonObject} config or null if invalid/missing.
 */
export function extractAmpAnalyticsConfig(a4a, responseHeaders) {
  if (!responseHeaders.has(AMP_ANALYTICS_HEADER)) {
    return null;
  }
  try {
    const analyticsConfig =
        parseJson(responseHeaders.get(AMP_ANALYTICS_HEADER));
    dev().assert(Array.isArray(analyticsConfig['url']));
    const urls = analyticsConfig['url'];
    if (!urls.length) {
      return null;
    }

    const config = /** @type {JsonObject}*/ ({
      'transport': {'beacon': false, 'xhrpost': false},
      'triggers': {
        'continuousVisible': {
          'on': 'visible',
          'visibilitySpec': {
            'selector': 'amp-ad',
            'selectionMethod': 'closest',
            'visiblePercentageMin': 50,
            'continuousTimeMin': 1000,
          },
        },
        'continuousVisibleIniLoad': {
          'on': 'ini-load',
          'selector': 'amp-ad',
          'selectionMethod': 'closest',
        },
        'continuousVisibleRenderStart': {
          'on': 'render-start',
          'selector': 'amp-ad',
          'selectionMethod': 'closest',
        },
      },
    });

    // Discover and build visibility endpoints.
    const requests = dict();
    for (let idx = 1; idx <= urls.length; idx++) {
      // TODO: Ensure url is valid and not freeform JS?
      requests[`visibility${idx}`] = `${urls[idx - 1]}`;
    }
    // Security review needed here.
    config['requests'] = requests;
    config['triggers']['continuousVisible']['request'] =
        Object.keys(requests);
    return config;
  } catch (err) {
    dev().error('AMP-A4A', 'Invalid analytics', err,
        responseHeaders.get(AMP_ANALYTICS_HEADER));
  }
  return null;
}

/**
 * Add new experiment IDs to a (possibly empty) existing set of experiment IDs.
 * The {@code currentIdString} may be {@code null} or {@code ''}, but if it is
 * populated, it must contain a comma-separated list of integer experiment IDs
 * (per {@code parseExperimentIds()}).  Returns the new set of IDs, encoded
 * as a comma-separated list.  Does not de-duplicate ID entries.
 *
 * @param {!Array<string>} newIds IDs to merge in. Should contain stringified
 *     integer (base 10) experiment IDs.
 * @param {?string} currentIdString  If present, a string containing a
 *   comma-separated list of integer experiment IDs.
 * @returns {string}  New experiment list string, including newId iff it is
 *   a valid (integer) experiment ID.
 * @see parseExperimentIds, validateExperimentIds
 */
export function mergeExperimentIds(newIds, currentIdString) {
  const newIdString = newIds.filter(newId => Number(newId)).join(',');
  currentIdString = currentIdString || '';
  return currentIdString + (currentIdString && newIdString ? ',' : '')
      + newIdString;
}

/**
 * Adds two CSI signals to the given amp-analytics configuration object, one
 * for render-start, and one for ini-load.
 *
 * @param {!Window} win
 * @param {!Element} element The ad slot.
 * @param {!JsonObject} config The original config object.
 * @param {?string} qqid
 * @param {boolean} isVerifiedAmpCreative
 * @param {number} deltaTime The time difference, in ms, between the lifecycle
 *   reporter's initialization and now.
 * @param {number} initTime The initialization time, in ms, of the lifecycle
 *   reporter.
 * @return {?JsonObject} config or null if invalid/missing.
 */
export function addCsiSignalsToAmpAnalyticsConfig(win, element, config,
    qqid, isVerifiedAmpCreative, deltaTime, initTime) {
  // Add CSI pingbacks.
  const correlator = getCorrelator(win);
  const slotId = Number(element.getAttribute('data-amp-slot-index'));
  const eids = encodeURIComponent(
      element.getAttribute(EXPERIMENT_ATTRIBUTE));
  const adType = element.getAttribute('type');
  const baseCsiUrl = 'https://csi.gstatic.com/csi?s=a4a' +
      `&c=${correlator}&slotId=${slotId}&qqid.${slotId}=${qqid}` +
      `&dt=${initTime}` +
      (eids != 'null' ? `&e.${slotId}=${eids}` : '') +
      `&rls=$internalRuntimeVersion$&adt.${slotId}=${adType}`;
  deltaTime = Math.round(deltaTime);
  const isAmpSuffix = isVerifiedAmpCreative ? 'Friendly' : 'CrossDomain';
  config['requests']['iniLoadCsi'] = baseCsiUrl +
      `&met.a4a.${slotId}=iniLoadCsi${isAmpSuffix}.${deltaTime}`;
  config['requests']['renderStartCsi'] = baseCsiUrl +
      `&met.a4a.${slotId}=renderStartCsi${isAmpSuffix}.${deltaTime}`;
  config['triggers']['continuousVisibleIniLoad']['request'] =
      'iniLoadCsi';
  config['triggers']['continuousVisibleRenderStart']['request'] =
      'renderStartCsi';

  // Add CSI ping for visibility.
  config['requests']['visibilityCsi'] = baseCsiUrl +
      `&met.a4a.${slotId}=visibilityCsi.${deltaTime}`;
  config['triggers']['continuousVisible']['request'].push('visibilityCsi');
  return config;
}

/**
 * Returns an array of two-letter codes representing the amp-ad containers
 * enclosing the given ad element.
 *
 * @param {!Element} adElement
 * @return {!Array<string>}
 */
export function getEnclosingContainerTypes(adElement) {
  const containerTypeSet = {};
  for (let el = adElement.parentElement, counter = 0;
      el && counter < 20; el = el.parentElement, counter++) {
    const tagName = el.tagName.toUpperCase();
    if (ValidAdContainerTypes[tagName]) {
      containerTypeSet[ValidAdContainerTypes[tagName]] = true;
    }
  }
  return Object.keys(containerTypeSet);
}

/**
 * Appends parameter to ad request indicating error state so long as error
 * parameter is not already present or url has been truncated.
 * @param {string} adUrl used for network request
 * @param {string} parameterValue to be appended
 * @return {string|undefined} potentially modified url, undefined
 */
export function maybeAppendErrorParameter(adUrl, parameterValue) {
  dev().assert(!!adUrl && !!parameterValue);
  // Add parameter indicating error so long as the url has not already been
  // truncated and error parameter is not already present.  Note that we assume
  // that added, error parameter length will be less than truncation parameter
  // so adding will not cause length to exceed maximum.
  if (new RegExp(`[?|&](${encodeURIComponent(TRUNCATION_PARAM.name)}=` +
      `${encodeURIComponent(String(TRUNCATION_PARAM.value))}|aet=[^&]*)$`)
      .test(adUrl)) {
    return;
  }
  const modifiedAdUrl = adUrl + `&aet=${parameterValue}`;
  dev().assert(modifiedAdUrl.length <= MAX_URL_LENGTH);
  return modifiedAdUrl;
}
