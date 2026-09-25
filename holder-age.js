(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TigHolderAge = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function classify(firstReceived, asOf) {
    if (!Number.isSafeInteger(firstReceived) || firstReceived <= 0 || firstReceived > asOf) {
      return { label: 'History unavailable', days: null };
    }
    var days = Math.floor((asOf - firstReceived) / 86400);
    return { days: days, label: days >= 365 ? 'Diamond holder' : days >= 180 ? 'Long-term holder' : days >= 30 ? 'Established holder' : 'Fresh holder' };
  }
  return { classify: classify };
}));
