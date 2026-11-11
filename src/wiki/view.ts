import { notesWikiMarkup } from './view-markup';
import { notesWikiScript } from './view-script';
import { notesWikiStyle } from './view-style';

// The sandboxed plugin view has an opaque origin and no network access, so the
// whole UI is one self-contained document driven by window.agentberth.call().
export const notesWikiView = '<style>' + notesWikiStyle + '</style>' + notesWikiMarkup + '<script>' + notesWikiScript + '</script>';
