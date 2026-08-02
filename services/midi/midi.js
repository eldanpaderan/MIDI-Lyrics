/**
 * services/midi/midi.js
 *
 * Core MIDI device connection and message routing (Web MIDI API).
 * Extracted from app.js during the repository restructuring; logic
 * unchanged from the original — this remains a page-turner (footswitch/
 * pedal-style Next/Previous), not a timing/sequencer engine.
 */
import { state, navigate } from '../ui/viewer.js';
import { midiKey, midiDesc } from './bindings.js';
import { updateMidiMappingInfo } from './learn.js';
import { showToast } from '../utils/helpers.js';
import { setPillState } from '../ui/toolbar.js';
import { saveLocalPrefs } from '../utils/storage.js';

export async function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    setPillState('midi-pill', 'error', 'No MIDI');
    return;
  }
  try {
    state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    setPillState('midi-pill', 'connected', 'MIDI');
    state.midiAccess.inputs.forEach(input => {
      input.onmidimessage = onMIDIMessage;
    });
    state.midiAccess.onstatechange = (e) => {
      if (e.port.type === 'input') {
        if (e.port.state === 'connected') {
          e.port.onmidimessage = onMIDIMessage;
          showToast(`MIDI: ${e.port.name} connected`, 'success');
        }
      }
    };
    showToast('MIDI connected', 'success');
  } catch (err) {
    setPillState('midi-pill', 'error', 'MIDI');
    showToast('MIDI access denied', 'error');
  }
}

export function onMIDIMessage(event) {
  const [status, data1, data2] = event.data;
  const type    = status >> 4;
  const channel = status & 0x0f;
  // type 9 = Note On, type 11 = Control Change
  if (type !== 9 && type !== 11) return;
  if (type === 9 && data2 === 0) return; // Note off (velocity 0)

  const key = midiKey(type, channel, data1);

  if (state.midiLearn) {
    // Assign based on learn step
    if (!state.midiNextNote) {
      state.midiNextNote = { type, channel, note: data1, key };
      showToast(`Next Page assigned: ${midiDesc(type, data1)}`, 'success');
      document.getElementById('midi-learn-label').textContent = 'Learning PREV… press a button';
    } else if (!state.midiPrevNote) {
      state.midiPrevNote = { type, channel, note: data1, key };
      showToast(`Prev Page assigned: ${midiDesc(type, data1)}`, 'success');
      state.midiLearn = false;
      document.getElementById('midi-learn-btn').classList.remove('learning');
      document.getElementById('midi-learn-label').textContent = 'MIDI Learn: OFF';
    }
    updateMidiMappingInfo();
    saveLocalPrefs();
    return;
  }

  // Check mappings
  if (state.midiNextNote && key === state.midiNextNote.key) {
    navigate(1);
  } else if (state.midiPrevNote && key === state.midiPrevNote.key) {
    navigate(-1);
  }
}
