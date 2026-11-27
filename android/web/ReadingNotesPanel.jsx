import {MobileExplorationEntry} from './MobileRecommendations.jsx';
import React,{useMemo} from 'react';
import {call} from '../bridge/library.mjs';
import {useI18n} from './i18n.js';
import {ReadingNotesPage} from '../../plugins/workbench/src/reading/ReadingNotesPage.jsx';
import {MobileCanvas} from './MobileWorkspace.jsx';
import {mobileReadingNotes} from '../../plugins/workbench/src/reading/adapters.mjs';
import '../../plugins/workbench/src/reading/reading-notes.css';
export function ReadingNotesPanel({libraryId,workspace,onPageStateChange,request=call}){
 const {t}=useI18n();const api=useMemo(()=>mobileReadingNotes(request,libraryId,{allOrigins:true}),[request,libraryId]);
 return libraryId?<ReadingNotesPage continuous key={libraryId} api={api} t={t} relatedRpc={workspace?.rpc} renderExploration={workspace?r=><MobileExplorationEntry workspace={workspace} record={r}/>:undefined} sourceLibraryId={libraryId}
   canvasActionLabel={t('展开相关内容','Explore related content')} renderCanvas={workspace?(root,_search,onClose)=><MobileCanvas root={root} workspace={workspace} onClose={onClose}/>:undefined} onPageStateChange={onPageStateChange}/>:<p>{t('请先选择资料库','Choose a library first')}</p>;
}
