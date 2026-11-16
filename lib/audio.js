'use strict';
// Same list as the AUDIO regex in app/index.html (+ a few extra containers)
const AUDIO_RE = /\.(mp3|flac|m4a|mp4|aac|ogg|oga|opus|wav|wma|aiff?|ape|wv|mka|webm)$/i;

const MIME = {
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', wma: 'audio/x-ms-wma',
  aif: 'audio/aiff', aiff: 'audio/aiff', ape: 'audio/x-ape', wv: 'audio/x-wavpack',
  mka: 'audio/x-matroska', webm: 'audio/webm',
};

const isAudio = (name) => AUDIO_RE.test(String(name || ''));
const mimeFor = (name) => MIME[String(name || '').split('.').pop().toLowerCase()] || 'application/octet-stream';

module.exports = { AUDIO_RE, isAudio, mimeFor };
