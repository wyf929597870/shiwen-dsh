import React,{useMemo} from 'react';
import {call} from '../bridge/library.mjs';
import {useI18n} from './i18n.js';
import {ReadingNotesPage} from '../../plugins/workbench/src/reading/ReadingNotesPage.jsx';
import {mobileReadingNotes} from '../../plugins/workbench/src/reading/adapters.mjs';
import '../../plugins/workbench/src/reading/reading-notes.css';
export function ReadingNotesPanel({libraryId,onPageStateChange,request=call}){
 const {t}=useI18n();const api=useMemo(()=>mobileReadingNotes(request,libraryId),[request,libraryId]);
 return libraryId?<ReadingNotesPage key={libraryId} api={api} t={t} onPageStateChange={onPageStateChange}/>:<p>{t('请先选择资料库','Choose a library first')}</p>;
}
