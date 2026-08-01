cmake_minimum_required(VERSION 3.21)
project(gr_runner LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets)
qt_standard_project_setup()

# The Emscripten toolchain does not predefine the WHOLE_ARCHIVE link feature, but
# wasm-ld supports --whole-archive. Define it so $<LINK_LIBRARY:WHOLE_ARCHIVE,...>
# works below (used to force-include the core GR symbol set for EXPORT_ALL).
set(CMAKE_CXX_LINK_LIBRARY_USING_WHOLE_ARCHIVE
    "-Wl,--whole-archive" "<LINK_ITEM>" "-Wl,--no-whole-archive")
set(CMAKE_CXX_LINK_LIBRARY_USING_WHOLE_ARCHIVE_SUPPORTED TRUE)

# GNU Radio is a submodule of the world repo. Keep its source root separate from
# the WebAssembly build/output directories at the repository root.
get_filename_component(WORLD "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
if(DEFINED ENV{GR})
  set(GR $ENV{GR})
else()
  set(GR "${WORLD}/gnuradio")
endif()
set(WASM_ROOT "${WORLD}")
set(BUILDGR ${WASM_ROOT}/gr/build-gr)
set(SYSROOT ${WASM_ROOT}/sysroot)
set(QTGUI_TS ${WASM_ROOT}/qtgui/build/libgr_qtgui_ts.a)

# Include search path shared by the main module and the category side modules.
set(GR_INCLUDE_DIRS
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${GR}/gnuradio-runtime/include ${GR}/gr-blocks/include ${GR}/gr-fft/include
  ${GR}/gr-filter/include ${GR}/gr-analog/include ${GR}/gr-digital/include
  ${GR}/gr-fec/include ${GR}/gr-dtv/include
  ${GR}/gr-network/include ${GR}/gr-pdu/include ${GR}/gr-vocoder/include
  ${GR}/gr-qtgui/include
  ${WORLD}/gr-rds/include
  ${WORLD}/gr-foo/include
  ${WORLD}/gr-dvbs2/include
  ${WORLD}/gr-dvbs2rx/include
  ${WORLD}/gr-satellites/include
  ${BUILDGR}/gnuradio-runtime/include ${SYSROOT}/include)

# ---------------------------------------------------------------------------
# Main module: the always-loaded core. Built as an Emscripten MAIN_MODULE so it
# can dlopen category side modules at runtime. Links the core GR libraries
# (runtime/pmt/blocks/fft/filter/analog + fec, kept for dtv's link deps) plus
# gr-qtgui; the deferred categories (digital/dtv/network/pdu/vocoder) are NOT
# linked here — they live in side modules fetched on demand.
#
# MAIN_MODULE=2 (referenced-only) is used rather than =1: =1 whole-archives every
# input, which trips duplicate-symbol/embind errors in Qt's archives. =2 only
# exports EXPORTED_FUNCTIONS, so we pair it with EXPORT_ALL=1 and whole-archive
# the core GR + VOLK libraries: that guarantees every symbol a side module might
# import (including ones only deferred blocks reference) is present AND exported.
# All inputs must be -fPIC (the GR/qtgui/qwt/fftw/spdlog libs are rebuilt for it).
# ---------------------------------------------------------------------------
qt_add_executable(runner
  src/runner.cpp
  src/registry.cpp
  src/browser_file_source.cpp
  src/generated_registry.cpp
  src/generated_modules.cpp)
target_include_directories(runner PRIVATE ${GR_INCLUDE_DIRS})
# -fexceptions is required at COMPILE time, not just at link: Emscripten's default
# (catching disabled) drops the landing pads, so runner.cpp's try/catch around
# flowgraph construction never fires and a block's std::runtime_error escapes to
# JS as an opaque "Uncaught <pointer>" that kills the runtime instead of being
# reported as RUNNER_FAIL. The side modules already compile with catching on.
target_compile_options(runner PRIVATE -fPIC -fexceptions)

target_link_libraries(runner PRIVATE
  ${QTGUI_TS}
  # Whole-archive the core GR libs + VOLK so their full symbol set is present for
  # EXPORT_ALL to hand to side modules at dlopen time.
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,${BUILDGR}/gr-fec/lib/libgnuradio-fec.a>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,${BUILDGR}/gr-analog/lib/libgnuradio-analog.a>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,${BUILDGR}/gr-filter/lib/libgnuradio-filter.a>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,${BUILDGR}/gr-fft/lib/libgnuradio-fft.a>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,${BUILDGR}/gr-blocks/lib/libgnuradio-blocks.a>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,${BUILDGR}/gnuradio-runtime/lib/libgnuradio-runtime.a>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,${BUILDGR}/gnuradio-runtime/lib/pmt/libgnuradio-pmt.a>"
  "$<LINK_LIBRARY:WHOLE_ARCHIVE,${SYSROOT}/lib/libvolk.a>"
  # gr-digital is a deferred side module, but the hand-written digital
  # hierarchies in registry.cpp use a focused subset of its implementation
  # blocks. Link it normally so only those objects are pulled into core; the
  # generated standalone digital blocks remain in digital.wasm.
  ${BUILDGR}/gr-digital/lib/libgnuradio-digital.a
  ${SYSROOT}/lib/libqwt.a
  ${SYSROOT}/lib/libfftw3f.a ${SYSROOT}/lib/libfftw3.a
  ${SYSROOT}/lib/libboost_thread.a ${SYSROOT}/lib/libboost_program_options.a
  ${SYSROOT}/lib/libboost_regex.a ${SYSROOT}/lib/libboost_chrono.a
  ${SYSROOT}/lib/libboost_atomic.a ${SYSROOT}/lib/libboost_date_time.a
  ${SYSROOT}/lib/libboost_system.a
  ${SYSROOT}/lib/libspdlog.a ${SYSROOT}/lib/libgmpxx.a ${SYSROOT}/lib/libgmp.a
  Qt6::Widgets Qt6::Gui Qt6::Core)

target_link_options(runner PRIVATE
  -sMAIN_MODULE=2 -sEXPORT_ALL=1
  # EXPORT_ALL covers functions but not Emscripten's special exception-handling
  # data globals, which category side modules import as GOT.mem entries. Export
  # them (and the registry shim) explicitly so side-module relocation resolves.
  -sEXPORTED_FUNCTIONS=_main,_gr_run_json,_free,_malloc,_wasm_registry_add
  # The remaining symbols side modules import from main (libc++abi/compiler-rt:
  # __cxa_pure_virtual, std type-info vtables, the thread_local exception globals,
  # …) are exported via the generated response file appended at the end of this
  # file (-Wl,@side_exports.rsp); EXPORT_ALL alone does not cover them.
  # Prewarm a large worker pool: GR runs one thread per block, and if start()
  # exhausts the pool it blocks the main browser thread creating a worker
  # (deadlock). Must cover Qt's threads + the largest flowgraph's block count.
  -sPTHREAD_POOL_SIZE=64 -sPTHREAD_POOL_SIZE_STRICT=0
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456
  -sALLOW_TABLE_GROWTH=1
  -sNO_DISABLE_EXCEPTION_CATCHING
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,stringToNewUTF8,UTF8ToString,FS
  # Diagnostics panel: injected into the page, survives Qt's html regeneration.
  --post-js ${CMAKE_CURRENT_SOURCE_DIR}/src/diag.js)

# Rebuild the link step when the panel JS changes (--post-js isn't a tracked dep).
set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/diag.js)

# Optimized/release artifact: configure with -DCMAKE_BUILD_TYPE=Release to run the
# link-time whole-program wasm-opt pass (the default link is -O0, which is why the
# unoptimized core wasm is ~100 MB). -Oz targets size. Dead-code elimination is
# safe here: the symbols side modules need are exported (roots) via EXPORT_ALL +
# side_exports.rsp, and the addFunction JS patch anchors on a name wasm-opt/minify
# preserve. Left off by default so ordinary rebuilds stay fast.
if(CMAKE_BUILD_TYPE STREQUAL "Release")
  target_link_options(runner PRIVATE -Oz)
endif()

# Patch the generated runner.js for the Qt+MAIN_MODULE addFunction-signature bug.
add_custom_command(TARGET runner POST_BUILD
  COMMAND python3 ${CMAKE_CURRENT_SOURCE_DIR}/src/patch_runner_js.py
          ${CMAKE_CURRENT_BINARY_DIR}/runner.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/runner.html
          ${CMAKE_CURRENT_BINARY_DIR}/runner.html
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/browser_file_reader.js
          ${CMAKE_CURRENT_BINARY_DIR}/browser_file_reader.js
  COMMENT "Patching runner.js addFunction signature default")
set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS
  ${CMAKE_CURRENT_SOURCE_DIR}/src/runner.html
  ${CMAKE_CURRENT_SOURCE_DIR}/src/browser_file_reader.js)

# ---------------------------------------------------------------------------
# Category side modules: one WebAssembly SIDE_MODULE per deferred category. Each
# links only its own libgnuradio-<m>.a plus its generated self-registering
# factory table; every other symbol (runtime, VOLK, libc++, wasm_registry_add)
# stays undefined and is resolved against the main module at dlopen time. Built
# -O2 because these are the on-demand download payloads. No Qt — the block
# factories construct GR blocks only; GUI sinks stay in the core module.
# ---------------------------------------------------------------------------
set(DEFERRED_MODULES digital dtv network pdu vocoder)

# Assemble -I flags for the raw em++ side-module compile.
set(SIDE_INCLUDE_FLAGS "")
foreach(dir ${GR_INCLUDE_DIRS})
  list(APPEND SIDE_INCLUDE_FLAGS -I${dir})
endforeach()

set(SIDE_MODULE_OUTPUTS "")
foreach(m ${DEFERRED_MODULES})
  set(src ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_${m}.cpp)
  set(lib ${BUILDGR}/gr-${m}/lib/libgnuradio-${m}.a)
  set(out ${CMAKE_CURRENT_BINARY_DIR}/${m}.wasm)
  add_custom_command(
    OUTPUT ${out}
    COMMAND ${CMAKE_CXX_COMPILER}
      -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
      -sNO_DISABLE_EXCEPTION_CATCHING
      # Must match the main module's ABI: Qt links the main with WASM_BIGINT, so
      # i64 params are passed natively. Without this the side module legalises i64
      # into two i32s and shared functions (e.g. nlohmann dump_integer<uint64>)
      # fail WebAssembly.instantiate with an imported-function type mismatch.
      -sWASM_BIGINT=1
      ${SIDE_INCLUDE_FLAGS}
      ${src}
      ${lib}
      -o ${out}
    DEPENDS ${src} ${lib}
            ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
            ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
    COMMENT "Building category side module ${m}.wasm"
    VERBATIM)
  list(APPEND SIDE_MODULE_OUTPUTS ${out})
endforeach()

# gr-rds is an out-of-tree module: it is NOT built by the gr/build-gr
# umbrella build, so there is no libgnuradio-rds.a to link like the modules above.
# Instead compile its own lib/*_impl.cc straight into the rds side module together
# with the generated self-registering factory table. config.h and the *_impl.h
# headers resolve next to the sources (gr-rds/lib); public rds/*.h headers come
# from gr-rds/include (already in GR_INCLUDE_DIRS above). The pristine upstream
# submodule normally generates config.h and uses Boost.Locale for one ISO-8859-2
# conversion; the browser build supplies narrow, header-only shims for both.
set(RDS_LIB ${WORLD}/gr-rds/lib)
set(RDS_WASM_SHIMS ${CMAKE_CURRENT_SOURCE_DIR}/src/rds_wasm_shims)
set(RDS_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_rds.cpp
  ${RDS_LIB}/decoder_impl.cc
  ${RDS_LIB}/encoder_impl.cc
  ${RDS_LIB}/parser_impl.cc
  ${RDS_LIB}/tag_to_msg_impl.cc)
set(rds_out ${CMAKE_CURRENT_BINARY_DIR}/rds.wasm)
add_custom_command(
  OUTPUT ${rds_out}
  COMMAND ${CMAKE_CXX_COMPILER}
    -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sWASM_BIGINT=1
    -I${RDS_WASM_SHIMS}
    ${SIDE_INCLUDE_FLAGS}
    ${RDS_SOURCES}
    -o ${rds_out}
  DEPENDS ${RDS_SOURCES}
          ${RDS_WASM_SHIMS}/config.h
          ${RDS_WASM_SHIMS}/boost/locale.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module rds.wasm (out-of-tree gr-rds sources)"
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${rds_out})

# gr-foo: another out-of-tree module, handled exactly like gr-rds above — its own
# lib/*.cc are compiled straight into foo.wasm. selector/valve are Python
# hier_block2s (no C++) and are excluded; packet_pad2's optional UHD tx_time
# tagging is #ifdef FOO_UHD (undefined here), so no UHD dependency is pulled in.
# The submodule is pinned to pristine upstream, so the config.h its CMake would
# have generated comes from a runner-owned shim instead.
set(FOO_LIB ${WORLD}/gr-foo/lib)
set(FOO_WASM_SHIMS ${CMAKE_CURRENT_SOURCE_DIR}/src/foo_wasm_shims)
set(FOO_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_foo.cpp
  ${FOO_LIB}/burst_tagger_impl.cc
  ${FOO_LIB}/channel_model_impl.cc
  ${FOO_LIB}/packet_dropper_impl.cc
  ${FOO_LIB}/packet_pad2.cc
  ${FOO_LIB}/pad_tagged_stream_impl.cc
  ${FOO_LIB}/periodic_msg_source_impl.cc
  ${FOO_LIB}/random_periodic_msg_source_impl.cc
  ${FOO_LIB}/rtt_measure_impl.cc
  ${FOO_LIB}/wireshark_connector_impl.cc)
set(foo_out ${CMAKE_CURRENT_BINARY_DIR}/foo.wasm)
add_custom_command(
  OUTPUT ${foo_out}
  COMMAND ${CMAKE_CXX_COMPILER}
    -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sWASM_BIGINT=1
    -I${FOO_WASM_SHIMS}
    ${SIDE_INCLUDE_FLAGS}
    ${FOO_SOURCES}
    -o ${foo_out}
  DEPENDS ${FOO_SOURCES}
          ${FOO_WASM_SHIMS}/config.h
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module foo.wasm (out-of-tree gr-foo sources)"
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${foo_out})

# gr-dvbs2 (drmpeg): another out-of-tree module, same treatment. bbheader_source
# is excluded — it is a UDP transport-stream source built on Boost.Asio (host
# networking), which has no meaning in the browser sandbox and is not in the WASM
# Boost set; it stays greyed out in the palette. The other 7 blocks form the
# DVB-S2 transmit chain (bbheader -> bbscrambler -> bch -> ldpc -> interleaver ->
# modulator -> physical). DVB-S2 constants come from the checked-in
# include/dvbs2/dvbs2_config.h; lib/config.h is the empty generated stub.
set(DVBS2_LIB ${WORLD}/gr-dvbs2/lib)
set(DVBS2_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_dvbs2.cpp
  ${DVBS2_LIB}/bbheader_bb_impl.cc
  ${DVBS2_LIB}/bbscrambler_bb_impl.cc
  ${DVBS2_LIB}/bch_bb_impl.cc
  ${DVBS2_LIB}/ldpc_bb_impl.cc
  ${DVBS2_LIB}/interleaver_bb_impl.cc
  ${DVBS2_LIB}/modulator_bc_impl.cc
  ${DVBS2_LIB}/physical_cc_impl.cc)
set(dvbs2_out ${CMAKE_CURRENT_BINARY_DIR}/dvbs2.wasm)
add_custom_command(
  OUTPUT ${dvbs2_out}
  COMMAND ${CMAKE_CXX_COMPILER}
    -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sWASM_BIGINT=1
    ${SIDE_INCLUDE_FLAGS}
    ${DVBS2_SOURCES}
    -o ${dvbs2_out}
  DEPENDS ${DVBS2_SOURCES}
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module dvbs2.wasm (out-of-tree gr-dvbs2 sources)"
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${dvbs2_out})

# gr-dvbs2rx (drmpeg): the DVB-S2/T2 receive-side FEC decoders (bbdeheader,
# bbdescrambler, bch_decoder, ldpc_decoder). Another OOT module, same treatment.
# Its LDPC/BCH decoder is a header-only SIMD library (lib/*.hh) that dispatches on
# __AVX2__/__SSE4_1__/__ARM_NEON__ — none defined under Emscripten, so it falls
# back to the generic scalar path (no x86 intrinsics). Deps are stdlib-only.
# DVB constants come from the checked-in include/dvbs2rx/dvb_config.h. The
# submodule is pinned to pristine upstream, so the config.h its CMake would have
# generated comes from a runner-owned shim instead.
set(DVBS2RX_LIB ${WORLD}/gr-dvbs2rx/lib)
set(DVBS2RX_WASM_SHIMS ${CMAKE_CURRENT_SOURCE_DIR}/src/dvbs2rx_wasm_shims)
set(DVBS2RX_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_dvbs2rx.cpp
  ${DVBS2RX_LIB}/bbdeheader_bb_impl.cc
  ${DVBS2RX_LIB}/bbdescrambler_bb_impl.cc
  ${DVBS2RX_LIB}/bch_decoder_bb_impl.cc
  ${DVBS2RX_LIB}/ldpc_decoder_cb_impl.cc)
set(dvbs2rx_out ${CMAKE_CURRENT_BINARY_DIR}/dvbs2rx.wasm)
add_custom_command(
  OUTPUT ${dvbs2rx_out}
  COMMAND ${CMAKE_CXX_COMPILER}
    -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sWASM_BIGINT=1
    -I${DVBS2RX_WASM_SHIMS}
    ${SIDE_INCLUDE_FLAGS}
    ${DVBS2RX_SOURCES}
    -o ${dvbs2rx_out}
  DEPENDS ${DVBS2RX_SOURCES}
          ${DVBS2RX_WASM_SHIMS}/config.h
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module dvbs2rx.wasm (out-of-tree gr-dvbs2rx sources)"
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${dvbs2rx_out})

# gr-satellites: telemetry framing, coding, FEC, and utility blocks. Like the
# other OOT modules, compile its implementation and bundled C/C++ codec sources
# directly into an on-demand side module. The upstream CMake build generates an
# otherwise empty config.h, supplied here as a runner-owned shim so the submodule
# can remain pinned to a pristine upstream branch.
set(SATELLITES_LIB ${WORLD}/gr-satellites/lib)
set(SATELLITES_WASM_SHIMS ${CMAKE_CURRENT_SOURCE_DIR}/src/satellites_wasm_shims)
set(SATELLITES_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_satellites.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/satellites_wasm_blocks.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/satellites_wasm_hier.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/src/satellites_wasm_deframers.cpp
  ${SATELLITES_LIB}/ax100_decode_impl.cc
  ${SATELLITES_LIB}/convolutional_encoder_impl.cc
  ${SATELLITES_LIB}/costas_loop_8apsk_cc_impl.cc
  ${SATELLITES_LIB}/crc.cc
  ${SATELLITES_LIB}/crc_append_impl.cc
  ${SATELLITES_LIB}/crc_check_impl.cc
  ${SATELLITES_LIB}/decode_ra_code_impl.cc
  ${SATELLITES_LIB}/decode_rs_impl.cc
  ${SATELLITES_LIB}/descrambler308_impl.cc
  ${SATELLITES_LIB}/distributed_syncframe_soft_impl.cc
  ${SATELLITES_LIB}/doppler_correction_impl.cc
  ${SATELLITES_LIB}/encode_rs_impl.cc
  ${SATELLITES_LIB}/fixedlen_to_pdu_impl.cc
  ${SATELLITES_LIB}/frame_counter_impl.cc
  ${SATELLITES_LIB}/golay24.c
  ${SATELLITES_LIB}/kurtosis_impl.cc
  ${SATELLITES_LIB}/level_to_message_impl.cc
  ${SATELLITES_LIB}/lilacsat1_demux_impl.cc
  ${SATELLITES_LIB}/manchester_sync_impl.cc
  ${SATELLITES_LIB}/matrix_deinterleaver_soft_impl.cc
  ${SATELLITES_LIB}/message_counter_impl.cc
  ${SATELLITES_LIB}/nanocom_golay_decode_length_impl.cc
  ${SATELLITES_LIB}/nrzi_decode_impl.cc
  ${SATELLITES_LIB}/nrzi_encode_impl.cc
  ${SATELLITES_LIB}/nusat_decoder_impl.cc
  ${SATELLITES_LIB}/packet_csma_impl.cc
  ${SATELLITES_LIB}/pdu_add_meta_impl.cc
  ${SATELLITES_LIB}/pdu_head_tail_impl.cc
  ${SATELLITES_LIB}/pdu_length_filter_impl.cc
  ${SATELLITES_LIB}/pdu_scrambler_impl.cc
  ${SATELLITES_LIB}/phase_unwrap_impl.cc
  ${SATELLITES_LIB}/randomizer.c
  ${SATELLITES_LIB}/selector_impl.cc
  ${SATELLITES_LIB}/time_dependent_delay_impl.cc
  ${SATELLITES_LIB}/u482c_decode_impl.cc
  ${SATELLITES_LIB}/u482c_encode_impl.cc
  ${SATELLITES_LIB}/varlen_packet_framer_impl.cc
  ${SATELLITES_LIB}/varlen_packet_tagger_impl.cc
  ${SATELLITES_LIB}/viterbi.c
  ${SATELLITES_LIB}/viterbi_decoder_impl.cc
  ${SATELLITES_LIB}/libfec/decode_rs_8.c
  ${SATELLITES_LIB}/libfec/decode_rs_ccsds.c
  ${SATELLITES_LIB}/libfec/decode_rs_char.c
  ${SATELLITES_LIB}/libfec/encode_rs_8.c
  ${SATELLITES_LIB}/libfec/encode_rs_ccsds.c
  ${SATELLITES_LIB}/libfec/encode_rs_char.c
  ${SATELLITES_LIB}/libfec/taltab.c
  ${SATELLITES_LIB}/libfec/ccsds.c
  ${SATELLITES_LIB}/libfec/init_rs_char.c
  ${SATELLITES_LIB}/radecoder/ra_config.c
  ${SATELLITES_LIB}/radecoder/ra_decoder_gen.c
  ${SATELLITES_LIB}/radecoder/ra_lfsr.c
  ${SATELLITES_LIB}/radecoder/ra_encoder.c
  ${SATELLITES_LIB}/viterbi/viterbi.cc)
add_library(satellites_side_objects OBJECT EXCLUDE_FROM_ALL ${SATELLITES_SOURCES})
set_target_properties(satellites_side_objects PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON)
target_include_directories(satellites_side_objects PRIVATE
  ${SATELLITES_WASM_SHIMS}
  ${GR_INCLUDE_DIRS})
target_compile_options(satellites_side_objects PRIVATE
  -pthread -fPIC -Oz
  $<$<COMPILE_LANGUAGE:CXX>:-fexceptions>)
set(satellites_out ${CMAKE_CURRENT_BINARY_DIR}/satellites.wasm)
add_custom_command(
  OUTPUT ${satellites_out}
  COMMAND ${CMAKE_CXX_COMPILER}
    -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sWASM_BIGINT=1
    $<TARGET_OBJECTS:satellites_side_objects>
    -o ${satellites_out}
  DEPENDS satellites_side_objects
          ${SATELLITES_SOURCES}
          ${SATELLITES_WASM_SHIMS}/config.h
          ${CMAKE_CURRENT_SOURCE_DIR}/src/satellites_wasm_blocks.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/satellites_wasm_hier.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/satellites_wasm_deframers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module satellites.wasm (out-of-tree gr-satellites sources)"
  COMMAND_EXPAND_LISTS
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${satellites_out})

add_custom_target(side_modules ALL DEPENDS ${SIDE_MODULE_OUTPUTS})
add_dependencies(runner side_modules)

# ---------------------------------------------------------------------------
# Export, from the main module, every libc++abi/compiler-rt/runtime symbol that
# a category side module imports via the GOT (EXPORT_ALL misses these). Uses
# --export-if-defined so main exports what it has and the side modules' own
# symbols are simply skipped. Generated after the side modules, consumed by the
# runner link.
# ---------------------------------------------------------------------------
set(SIDE_EXPORTS_RSP ${CMAKE_CURRENT_BINARY_DIR}/side_exports.rsp)
add_custom_command(
  OUTPUT ${SIDE_EXPORTS_RSP}
  COMMAND python3 ${CMAKE_CURRENT_SOURCE_DIR}/gen_side_exports.py
          ${SIDE_EXPORTS_RSP} ${SIDE_MODULE_OUTPUTS}
  DEPENDS ${SIDE_MODULE_OUTPUTS} ${CMAKE_CURRENT_SOURCE_DIR}/gen_side_exports.py
  COMMENT "Collecting side-module GOT imports for main-module re-exports"
  VERBATIM)
add_custom_target(side_exports DEPENDS ${SIDE_EXPORTS_RSP})
add_dependencies(runner side_exports)
target_link_options(runner PRIVATE -Wl,@${SIDE_EXPORTS_RSP})
set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS ${SIDE_EXPORTS_RSP})
