import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyAppearance} from '../android/web/i18n.js';

test('system appearance uses Android system state and follows later changes', () => {
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  const fakeWindow=new EventTarget();
  fakeWindow.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  globalThis.window=fakeWindow;
  globalThis.document={documentElement:{dataset:{},style:{}}};
  try {
    applyAppearance('dark',false);
    assert.equal(document.documentElement.dataset.theme,'dark');
    applyAppearance('system',false);
    assert.equal(document.documentElement.dataset.theme,'light');
    fakeWindow.dispatchEvent(new CustomEvent('shiwen-system-theme',{detail:true}));
    assert.equal(document.documentElement.dataset.theme,'dark');
    applyAppearance('light',true);
    fakeWindow.dispatchEvent(new CustomEvent('shiwen-system-theme',{detail:true}));
    assert.equal(document.documentElement.dataset.theme,'light');
  } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
});
