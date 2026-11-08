import React, {useEffect, useRef} from 'react';
import {renderMarkdownHtml} from './markdown-renderer.mjs';
import {call, isNative} from '../bridge/library.mjs';
import {useI18n} from './i18n.js';

const EMPTY_LIST = Object.freeze([]);
const MAX_PAGE_IMAGE_BYTES = 16 * 1024 * 1024;

export function MarkdownView({markdown = '', libraryId, recordId, branchId, attachmentDescriptors = EMPTY_LIST, branchAttachments = EMPTY_LIST}) {
  const root = useRef(null);
  const {language,t} = useI18n();
  const rendered = renderMarkdownHtml(markdown,language);
  const descriptorKey = JSON.stringify([attachmentDescriptors,branchAttachments]);
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    container.innerHTML = rendered;
    let active = true;
    let viewer;
    const allowZoom = image => {
      image.tabIndex=0;image.setAttribute('role','button');
      const open=()=>{if(!active||viewer)return;const dialog=document.createElement('dialog');viewer=dialog;dialog.className='md-image-viewer';
        const close=document.createElement('button');close.type='button';close.textContent=t('关闭','Close');close.setAttribute('aria-label',t('关闭图片','Close image'));
        const full=document.createElement('img');full.src=image.src;full.alt=image.alt;dialog.append(close,full);document.body.append(dialog);
        close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{dialog.remove();if(viewer===dialog)viewer=null;});dialog.showModal();};
      image.addEventListener('click',open);image.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
    };
    const networkImages = [...container.querySelectorAll('.md-network-image[data-image-url]')];
    for (const button of networkImages) button.addEventListener('click', () => {
      let url;try { url = new URL(button.dataset.imageUrl); } catch { return; }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
      const image = document.createElement('img');image.className='md-attachment-image';image.alt=button.getAttribute('aria-label')||'';
      allowZoom(image);
      image.referrerPolicy='no-referrer';image.onerror=()=>{if(active&&image.isConnected)image.replaceWith(button);};
      image.src=url.href;button.replaceWith(image);
    });
    const pending = [...container.querySelectorAll('.md-attachment-pending[data-attachment-id],.md-attachment-pending[data-image-target]')];
    const maxImages = 20;
    let loadedBytes = 0;
    const loadedImages = [];
    let loadOne;
    const makeOnDemand = (placeholder, message) => {
      placeholder.textContent = message;
      placeholder.classList.add('md-image-missing','md-image-on-demand');
      placeholder.tabIndex = 0; placeholder.setAttribute('role','button');
      if (placeholder.dataset.onDemandBound) return;
      placeholder.dataset.onDemandBound = 'true';
      const load = () => {
        if (!active || !placeholder.isConnected || placeholder.dataset.loading === 'true') return;
        placeholder.dataset.loading = 'true';
        void loadOne(placeholder, true).finally(() => { if(placeholder.isConnected) delete placeholder.dataset.loading; });
      };
      placeholder.addEventListener('click', load);
      placeholder.addEventListener('keydown', event => { if(event.key==='Enter'||event.key===' '){event.preventDefault();load();} });
    };
    const releaseOldest = () => {
      const old = loadedImages.shift();
      if (!old || !old.image.isConnected) return;
      if (viewer) { viewer.close(); viewer.remove(); viewer = null; }
      old.image.src = '';
      const placeholder = old.placeholder;
      placeholder.textContent = t('图片已卸载以释放内存；点击可重新查看','Image unloaded to free memory; click to view again');
      old.image.replaceWith(placeholder);
      loadedBytes = Math.max(0, loadedBytes - old.byteLength);
      makeOnDemand(placeholder, placeholder.textContent);
    };
    loadOne = async (placeholder, allowRelease = false) => {
      const attachmentId = placeholder.dataset.attachmentId;
      if (!isNative || !libraryId || !recordId) {
        placeholder.textContent = t('图片不可用：没有当前资料库和记录上下文','Image unavailable: no library and record context');
        placeholder.classList.add('md-image-missing'); return;
      }
      const descriptors = branchId ? [...branchAttachments, ...attachmentDescriptors] : attachmentDescriptors;
      const descriptor = attachmentId ? descriptors.find(item => String(item?.id ?? item?.attachmentId) === attachmentId) : null;
      const expectedHash = String(descriptor?.hash || '').toLowerCase();
      const sourceTarget = placeholder.dataset.imageTarget;
      if ((attachmentId && !/^[a-f0-9]{64}$/.test(expectedHash)) || (!attachmentId && (!sourceTarget || branchId))) {
        placeholder.textContent = t('图片不可用：缺少附件身份校验信息','Image unavailable: attachment identity metadata is missing');
        placeholder.classList.add('md-image-missing'); return;
      }
      try {
        const result = await call('attachmentImageRead', {libraryId, recordId, ...(attachmentId ? {attachmentId, expectedHash} : {sourceTarget}), ...(branchId ? {branchId} : {})});
        if (!active || !placeholder.isConnected) return;
        if (expectedHash && String(result.sha256 || '').toLowerCase() !== expectedHash) throw Error('ATTACHMENT_HASH_MISMATCH');
        if (!Number.isSafeInteger(result.byteLength) || result.byteLength < 1 || result.byteLength > MAX_PAGE_IMAGE_BYTES)
          throw Error('MARKDOWN_IMAGE_TOO_LARGE');
        if (loadedBytes + result.byteLength > MAX_PAGE_IMAGE_BYTES) {
          if (!allowRelease) {
            makeOnDemand(placeholder,t('图片需按需加载；点击查看时会先卸载较早图片','Image needs on-demand loading; earlier images will be unloaded when opened'));
            return;
          }
          while (loadedImages.length && (loadedBytes + result.byteLength > MAX_PAGE_IMAGE_BYTES || loadedImages.length >= maxImages)) releaseOldest();
        } else if (allowRelease && loadedImages.length >= maxImages) {
          releaseOldest();
        }
        const image = document.createElement('img');
        image.className = 'md-attachment-image'; image.alt = placeholder.getAttribute('aria-label') || '';
        image.loading = 'lazy'; allowZoom(image);
        image.src = `data:${result.mimeType};base64,${result.dataBase64}`;
        const restore = placeholder.cloneNode(false);
        restore.classList.remove('md-image-missing','md-image-on-demand'); delete restore.dataset.onDemandBound; delete restore.dataset.loading;
        loadedImages.push({image, byteLength:result.byteLength, placeholder:restore});
        loadedBytes += result.byteLength;
        placeholder.replaceWith(image);
      } catch (error) {
        if (!active || !placeholder.isConnected) return;
        const waiting = descriptor?.available === false || descriptor?.downloaded === false ||
          ['ATTACHMENT_NOT_AVAILABLE','BRANCH_ATTACHMENT_NOT_AVAILABLE','BRANCH_ATTACHMENT_WAITING_FOR_DOWNLOAD'].includes(error?.message);
        const message = waiting
          ? t('图片待下载：此分支的附件尚未下载到本机','Image waiting for download: this branch attachment is not on this device')
          : error?.message === 'MARKDOWN_IMAGE_TOO_LARGE'
            ? t('图片超过单张大小限制，无法加载','Image exceeds the per-image loading limit')
            : t('图片不可用：附件身份不匹配或缺失','Image unavailable: attachment identity mismatch or missing');
        if (waiting) makeOnDemand(placeholder,message);
        else { placeholder.textContent = message; placeholder.classList.add('md-image-missing'); }
      }
    };
    const loadImages = async () => {
      for (const [index, placeholder] of pending.entries()) {
        if (index >= maxImages) {
          makeOnDemand(placeholder,t('图片需按需加载；点击查看','Image available on demand; click to view'));
          continue;
        }
        await loadOne(placeholder);
      }
    };
    void loadImages();
    return () => { active = false;if(viewer){viewer.close();viewer.remove();viewer=null;}loadedImages.forEach(item=>{item.image.src='';}); };
  }, [rendered, markdown, libraryId, recordId, branchId, descriptorKey, language]);
  // The effect owns this subtree: React must not reapply the original HTML
  // and resurrect loading placeholders after native images are inserted.
  return <div ref={root} className="markdown-view"/>;
}
