// The Graham prompt suite: what the assistant is expected to be able to do.
//
// These are quality cases, not tests. Each one calls a real model on a real key
// and costs tokens, so nothing here runs in CI, in `npm test`, or in either
// smoke suite -- they run only when somebody asks for them, through
// scripts/eval_graham_suite.mjs. Nothing discovers this file automatically;
// the suite runner is the only thing that reads it.
//
// A case is deliberately more than a prompt. `expect` states what the run has
// to show for itself, because "the turn finished and the graph ran" passes for
// answers that ignored half the request -- a from-scratch prompt that quietly
// built on top of the welcome example still runs.
//
//   prompt   what a user types.
//   fresh    true starts from a blank canvas. Leave it false wherever the
//            editor's own starting state is part of what is being tested: the
//            editor opens on digital/welcome_example.grc ("PSK Tx with
//            Constellation") and never on nothing.
//   expect.clears        whether new_flowgraph should be called. false asserts
//                        it was NOT -- a request to modify what is on screen
//                        must not throw it away.
//   expect.notBefore     [a, b]: tool a must not be called before tool b. For
//                        an example named in the prompt, clearing the canvas is
//                        fine *after* read_example -- rebuilding a graph it has
//                        read is a legitimate way to modify it -- and destroys
//                        the request before it.
//   expect.tools         tool names that must appear in the transcript.
//   expect.blocks        substrings that must appear in a canvas block's label.
//   expect.absentBlocks  substrings that must NOT. Hardware SDRs belong here on
//                        any prompt that did not name one: they need a device
//                        and a permission click, so a graph built around one
//                        cannot run for the user who asked.
//   expect.run           'pass'  the runner must reach RUNNER_PASS
//                        'authorized' the run may instead be refused for
//                        hardware authorization. Only for a case whose prompt
//                        explicitly asks for hardware -- everywhere else,
//                        needing authorization is itself the failure.
//                        'any' do not judge the run.
export const CASES = [
  {
    name: 'bpsk-tx',
    prompt: 'create a new flowgraph that has a BPSK tx and some plots, then run it',
    // Deliberately NOT fresh: the canvas holds the welcome example, which is
    // itself a PSK transmitter with a constellation plot. This case is as much
    // about Graham clearing it as about what it builds.
    fresh: false,
    expect: {
      clears: true,
      blocks: ['PSK Mod', 'QT GUI'],
      absentBlocks: ['Note'],   // the welcome example's, if the canvas was not cleared
      run: 'pass',
    },
  },
  {
    name: 'wbfm-waterfall',
    prompt: 'build me a wideband FM receiver with a waterfall',
    fresh: false,
    expect: {
      clears: true,
      blocks: ['WBFM Receive', 'Waterfall'],
      // The point of the case. Nothing in the prompt names hardware, so
      // reaching for an SDR is wrong however plausible it looks: the user does
      // not necessarily own one, the run needs a permission click they cannot
      // give, and a receiver that cannot run is not an answer. It has to take
      // its signal from a recording or a simulated source, and therefore has
      // to actually run.
      absentBlocks: ['RTL-SDR', 'HackRF', 'PlutoSDR'],
      run: 'pass',
    },
  },
  {
    name: 'qpsk-sync',
    prompt: 'Open the example digital/synchronization_bpsk_recovery and adjust it ' +
            'to use QPSK, also adjust the sync portion to work with QPSK',
    fresh: false,
    expect: {
      // Reading the example and rebuilding it modified is a legitimate route,
      // so the mechanism is not what is checked -- only that the example was
      // read *before* anything cleared the canvas, and that what came out is
      // the example converted rather than a generic QPSK graph: the recovery
      // chain has to survive, with the sync blocks re-tuned for order 4.
      notBefore: ['new_flowgraph', 'read_example'],
      tools: ['read_example'],
      blocks: ['QPSK', 'Polyphase Clock Sync', 'Costas Loop'],
      run: 'pass',
    },
  },
  {
    name: 'modify-open-graph',
    // No example named and nothing to build: this is purely about the canvas
    // already on screen, which is the welcome example. It is the guard on the
    // from-scratch rule overreaching -- clearing here answers a question
    // nobody asked.
    prompt: 'add a frequency sink to the flowgraph that is currently open, then run it',
    fresh: false,
    expect: {
      clears: false,
      blocks: ['QT GUI Frequency Sink', 'PSK Mod'],
      run: 'pass',
    },
  },
  {
    name: 'fm-from-recording',
    prompt: 'Make an FM radio receiver, try to find an example of FM radio in the ' +
            'GNU Radio World recordings to use as a test, and then have the output ' +
            'go to both an Audio Sink and a Time Sink',
    fresh: false,
    expect: {
      clears: true,
      // The point of the case: the recording catalog is a tool call, not
      // something a model can guess a key for.
      tools: ['list_recordings'],
      blocks: ['Audio Sink', 'QT GUI Time Sink', 'Recording'],
      run: 'pass',
    },
  },
  {
    name: 'measure-tone',
    // A question with a right answer in Hz, which no counter in the run report
    // carries: the graph runs perfectly whatever the frequency is. Reading the
    // spectrum sink's own numbers is the only way to answer it, and a
    // screenshot is the expensive way to answer it badly.
    prompt: 'Build a flowgraph with a signal source at 12 kHz into a frequency sink, ' +
            'run it, and tell me exactly what frequency the peak is at',
    fresh: true,
    expect: {
      clears: true,
      tools: ['run_flowgraph', 'read_plot_data'],
      blocks: ['QT GUI Frequency Sink', 'Signal Source'],
      run: 'pass',
    },
  },
  {
    name: 'look-at-constellation',
    // The other half: a question about shape, where the numbers are a poor
    // instrument and looking is the point. The welcome example already plots a
    // constellation, so this is about observing what is there rather than
    // building anything -- and about not throwing the canvas away to do it.
    prompt: 'Run the flowgraph that is open and look at the constellation plot — ' +
            'does it look like a clean BPSK constellation to you?',
    fresh: false,
    expect: {
      clears: false,
      tools: ['run_flowgraph', 'capture_plots'],
      run: 'pass',
    },
  },
];

export const caseNamed = name => CASES.find(item => item.name === name);
