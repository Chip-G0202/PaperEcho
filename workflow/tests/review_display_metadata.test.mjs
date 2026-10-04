import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRssItems } from '../tools/stage1/retrieval_step.mjs';
import { getReviewDisplayMetadata } from '../tools/lib/review_display_metadata.mjs';
import { enrichManualReviewTitles } from '../tools/stage1/manual_review_translation_step.mjs';
import { generateLiteratureTitleTranslations } from '../tools/lib/title_translation_generation.mjs';
import { buildFinalExportPayload, isManualReviewReachable } from '../tools/stage4/finalize_exports_support.mjs';

const feed = (label, itemMetadata='', feedMetadata='') => `<rss xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${label}</title>${feedMetadata}<item><title>Synthetic English paper</title><link>https://example.org/paper</link>${itemMetadata}</item></channel></rss>`;
const manual = extra => ({title:'Synthetic English paper',doi:'10.1234/display',rule_grade:'D',llm_review_grade:'B',grade:'D',final_grade:'D',semantic_stage_status:'completed',pre_llm_skip_writeback:true,...extra});

test('RSS publication metadata is distinct from feed provenance and follows declared precedence', () => {
  const source = {name:'Canonical feed display',publicationTitle:'Configured Journal'};
  const [item] = parseRssItems(feed('AAAS: Science Advances: Table of Contents'), 'https://example.org/rss');
  assert.equal(item.journal,'Science Advances'); assert.equal(item.publicationTitle,'Science Advances');
  assert.equal(item.feed_title,'AAAS: Science Advances: Table of Contents'); assert.equal(item.feed_url,'https://example.org/rss');
  assert.equal(getReviewDisplayMetadata(item).source,'RSS');
  for (const metadata of ['<prism:publicationName>Item Journal</prism:publicationName>','<dc:source>Item Journal</dc:source>']) {
    assert.equal(parseRssItems(feed('Latest Results',metadata,'<prism:publicationName>Feed Journal</prism:publicationName>'),'fixture',source)[0].publicationTitle,'Item Journal');
  }
  assert.equal(parseRssItems(feed('Latest Results','','<prism:publicationName>Feed Journal</prism:publicationName>'),'fixture',source)[0].publicationTitle,'Configured Journal');
  assert.equal(parseRssItems(feed('Latest Results','','<prism:publicationName>Feed Journal</prism:publicationName>'),'fixture')[0].publicationTitle,'Feed Journal');
  assert.equal(parseRssItems(feed('Latest Results','<source url="https://example.org/feed">Original Feed Label</source>'),'fixture')[0].publicationTitle,'');
  const atom='<feed xmlns="http://www.w3.org/2005/Atom"><title>Latest Results</title><entry><title>Synthetic Atom</title><source><title>Original Feed Label</title></source></entry></feed>';
  assert.equal(parseRssItems(atom,'fixture')[0].publicationTitle,'');
});

test('generic feeds never become journals; real metadata wins and non-RSS venues are preserved', () => {
  for (const label of ['Latest Results','Recent Articles','Current Issue','Table of Contents','RSS']) {
    const [item] = parseRssItems(feed(label),'fixture');
    assert.equal(item.journal,''); assert.equal(item.feed_title,label);
    assert.equal(getReviewDisplayMetadata(item).journal,''); assert.equal(getReviewDisplayMetadata(item).source,'RSS');
    assert.equal(getReviewDisplayMetadata({...item,publicationTitle:'Real Journal',journal:label}).journal,'Real Journal');
  }
  assert.equal(getReviewDisplayMetadata({source_channel:'rss',journal:'AAAS: Science Advances: Table of Contents'}).journal,'Science Advances');
  for (const source of ['pubmed','pmc','openalex','zotero']) {
    const metadata = getReviewDisplayMetadata({source_platform:source,journal:'Unchanged Journal',publication_year:2026});
    assert.equal(metadata.journal,'Unchanged Journal'); assert.equal(metadata.year,'2026');
  }
});

test('Feedback and Manual use identical display projection, translation aliases and cache enrichment', () => {
  const base={title:'Synthetic English paper',translatedTitle:'Synthetic English paper',translated_title:'已有中文标题',source_platform:'rss',journal:'Latest Results',publicationTitle:'Real Journal',publication_date:'2026-10-04'};
  assert.deepEqual(getReviewDisplayMetadata({...base,rule_grade:'B',llm_review_grade:'B'}),getReviewDisplayMetadata(manual(base)));
  assert.equal(getReviewDisplayMetadata(base).translatedTitle,'已有中文标题');
  const cache=new Map([['synthetic english paper',{ok:true,zh:'共享缓存中文标题'}]]);
  const payload=buildFinalExportPayload({allAbcItems:[],manualCandidates:[manual({source_platform:'rss',journal:'Latest Results',publicationTitle:'Real Journal'})],translationCache:cache});
  assert.equal(payload.triaged.length,1);assert.equal(payload.triaged[0].translatedTitle,'共享缓存中文标题');
  assert.equal(payload.triaged[0].doi,'10.1234/display');assert.equal(payload.triaged[0].journal,'Latest Results');
});

test('workflow enrichment uses the shared translator only for reachable Manual items', async () => {
  const hold=manual({source_platform:'rss',publicationTitle:'Real Journal'});
  const excluded={...hold,doi:'10.1234/excluded',llm_review_grade:'D'};
  const duplicate={...hold,doi:'10.1234/duplicate',pre_llm_zotero_existing_duplicate:true};
  const untitled={...hold,title:'',doi:'10.1234/untitled'};
  let calls=0;
  const result=await enrichManualReviewTitles([hold,excluded,duplicate,untitled],{enabled:true,translateTitlesBatchImpl:async titles=>{calls++;assert.deepEqual(titles,[hold.title]);return {map:new Map([[hold.title,{ok:true,zh:'人工复核中文标题'}]])};}});
  assert.equal(calls,1);assert.equal(result.target_count,1);assert.equal(result.generated_count,1);
  assert.equal(result.items[0].translatedTitle,'人工复核中文标题');assert.equal(result.items[0].doi,hold.doi);
  assert.equal(isManualReviewReachable(result.items[0]),true);assert.equal(isManualReviewReachable(result.items[3]),true);
  assert.equal(result.items[1],excluded);assert.equal(result.items[2],duplicate);
});

test('disabled, unsuccessful and throwing translation never remove Manual actionability', async () => {
  const item=manual();let calls=0;
  const disabled=await enrichManualReviewTitles([item],{enabled:false,translateTitlesBatchImpl:async()=>{calls++;throw Error('must not call');}});
  assert.equal(calls,0);assert.equal(disabled.skipped_reason,'disabled_by_config');assert.equal(isManualReviewReachable(disabled.items[0]),true);
  const sharedDisabled=await generateLiteratureTitleTranslations([item],{enabled:false,translateTitlesBatchImpl:async()=>{calls++;throw Error('must not call');}});
  assert.equal(calls,0);assert.equal(sharedDisabled.skipped_reason,'disabled_by_config');assert.equal(sharedDisabled.items[0].title,item.title);
  for (const translateTitlesBatchImpl of [async()=>({map:new Map([[item.title,{ok:false,reason:'synthetic_failure'}]])}),async()=>{throw Error('synthetic_failure');}]) {
    const result=await enrichManualReviewTitles([item],{enabled:true,translateTitlesBatchImpl});
    assert.equal(result.failures.length,1);assert.equal(getReviewDisplayMetadata(result.items[0]).translatedTitle,'');
    assert.equal(result.items[0].title,item.title);assert.equal(isManualReviewReachable(result.items[0]),true);
  }
});
