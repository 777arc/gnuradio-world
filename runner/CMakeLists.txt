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
if(DEFINED ENV{DEPS_SRC})
  set(DEPS_SRC $ENV{DEPS_SRC})
else()
  set(DEPS_SRC ${WASM_ROOT}/deps/src)
endif()
set(QTGUI_TS ${WASM_ROOT}/qtgui/build/libgr_qtgui_ts.a)

# Module topology is shared with gen_registry.py. CMake still owns the concrete
# source lists below, while modules.json owns which categories are core/deferred.
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/modules.json MODULE_CONFIG_JSON)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
  ${CMAKE_CURRENT_SOURCE_DIR}/modules.json)
function(json_array_to_list output key)
  string(JSON count LENGTH "${MODULE_CONFIG_JSON}" ${key})
  set(values "")
  if(count GREATER 0)
    math(EXPR last "${count} - 1")
    foreach(index RANGE 0 ${last})
      string(JSON value GET "${MODULE_CONFIG_JSON}" ${key} ${index})
      list(APPEND values ${value})
    endforeach()
  endif()
  set(${output} ${values} PARENT_SCOPE)
endfunction()
json_array_to_list(IN_TREE_DEFERRED_MODULES in_tree_deferred)
json_array_to_list(ALL_DEFERRED_MODULES deferred)

# Hand-written block sources live outside runner/ so that runner/src/ holds the
# app and the generated factories only. blocks/src/ is what is not owned by any
# one vendored module; blocks/overlays/gr-<m>/ is that module's browser-side
# additions (metadata.yml, shims/, and any C++ rebuilt from a Python-only block).
set(BLOCKS ${WORLD}/blocks)
file(GLOB BLOCK_OVERLAY_DIRS ${BLOCKS}/overlays/gr-*)

# Include search path shared by the main module and the category side modules.
# The overlay directories are on it so a rebuilt block's header resolves by name
# from the generated registrar that constructs it.
set(GR_INCLUDE_DIRS
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
  ${BLOCKS}/src
  ${BLOCK_OVERLAY_DIRS}
  ${GR}/gnuradio-runtime/include ${GR}/gr-blocks/include ${GR}/gr-fft/include
  ${GR}/gr-filter/include ${GR}/gr-analog/include ${GR}/gr-digital/include
  ${GR}/gr-fec/include ${GR}/gr-dtv/include ${GR}/gr-channels/include
  ${GR}/gr-network/include ${GR}/gr-pdu/include ${GR}/gr-vocoder/include
  ${GR}/gr-qtgui/include
  ${WORLD}/gr-rds/include
  ${WORLD}/gr-foo/include
  ${WORLD}/gr-dvbs2/include
  ${WORLD}/gr-dvbs2rx/include
  ${WORLD}/gr-satellites/include
  ${WORLD}/gr-paint/include
  ${WORLD}/gr-fosphor/include
  ${WORLD}/gr-droneid/gnuradio/gr-droneid/include
  ${WORLD}/gr-ieee802_11/include
  ${WORLD}/gr-ieee802_15_4/include
  ${WORLD}/gr-hrpt/include
  ${WORLD}/gr-lora_sdr/include
  ${WORLD}/gr-radar/include
  ${WORLD}/gr-gsm/include
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
  ${BLOCKS}/src/js_pmt.cpp
  ${BLOCKS}/src/browser_file_source.cpp
  ${BLOCKS}/src/browser_file_sink.cpp
  ${BLOCKS}/src/browser_audio.cpp
  ${BLOCKS}/src/rtlsdr_source.cpp
  ${BLOCKS}/src/plutosdr_common.cpp
  ${BLOCKS}/src/plutosdr_source.cpp
  ${BLOCKS}/src/plutosdr_sink.cpp
  ${BLOCKS}/src/hackrf_common.cpp
  ${BLOCKS}/src/hackrf_source.cpp
  ${BLOCKS}/src/hackrf_sink.cpp
  ${BLOCKS}/src/spectrum_analyzer_sink.cpp
  ${BLOCKS}/overlays/gr-paint/paint_image_source.cpp
  ${BLOCKS}/overlays/gr-fosphor/fosphor_webgpu_sink.cpp
  ${BLOCKS}/overlays/gr-radar/radar_plots.cpp
  src/generated_registry.cpp
  src/generated_modules.cpp
  src/generated_js_blocks.cpp)
# Qt's WASM finalizer appends its own pool setting after ordinary link options.
# Use the supported target property so its final setting is the tier selected by
# runner.html before the modularized Emscripten runtime starts. Emscripten emits
# this string as a JavaScript expression, so it can size the prewarmed pool from
# the flowgraph (any integer, not a fixed ladder) instead of baking in one pool
# size for every run.
set_property(TARGET runner PROPERTY QT_WASM_PTHREAD_POOL_SIZE "globalThis.__grPoolTier")
target_include_directories(runner PRIVATE
  ${GR_INCLUDE_DIRS}
  # Needed only to inspect the exact flattened block list before scheduler
  # startup. This is the same pinned runtime implementation we link below.
  ${GR}/gnuradio-runtime/lib)
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
  # Same for gr-channels: its two fading models have hand-written factories (the
  # live fDTs/K setters), so those objects join core while channel_model's
  # generated factory stays in channels.wasm.
  ${BUILDGR}/gr-channels/lib/libgnuradio-channels.a
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
  -sEXPORTED_FUNCTIONS=_main,_gr_run_json,_gr_apply_gui_layout,_gr_read_plot_data,_gr_shutdown_flowgraph,_gr_finish_worker_preload,_gr_finish_pyodide_prepare,_gr_finish_js_sources,_gr_fosphor_webgpu_frequency,_gr_js_last_error,_gr_js_pmt_type,_gr_js_pmt_real,_gr_js_pmt_u64,_gr_js_pmt_length,_gr_js_pmt_ref,_gr_js_pmt_text,_gr_js_pmt_blob,_gr_js_pmt_make,_gr_js_pmt_seq,_gr_js_pmt_dict,_gr_js_pmt_blob_new,_gr_js_tags,_gr_js_tag_offset,_gr_js_tag_field,_gr_js_add_tag,_gr_js_nitems,_gr_js_publish,_free,_malloc,_wasm_registry_add
  # The remaining symbols side modules import from main (libc++abi/compiler-rt:
  # __cxa_pure_virtual, std type-info vtables, the thread_local exception globals,
  # …) are exported via the generated response file appended at the end of this
  # file (-Wl,@side_exports.rsp); EXPORT_ALL alone does not cover them.
  # GR runs one thread per block. The initial worker count is selected by
  # runner.html before startup; permit extra workers when hierarchy expansion
  # makes the top-level flowgraph count underestimate the scheduler thread count.
  -sPTHREAD_POOL_SIZE_STRICT=0
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456
  -sALLOW_TABLE_GROWTH=1
  -sNO_DISABLE_EXCEPTION_CATCHING
  # stringToUTF8 is the JS Block runtime's: it writes an error message into a
  # fixed buffer C++ already owns rather than allocating one.
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,stringToNewUTF8,stringToUTF8,UTF8ToString,FS
  # The JavaScript Block's runtime. --pre-js, not --post-js: it has to be in
  # scope of the module factory, which every em-pthread worker re-enters, so a
  # block's work() finds __grJs already defined in its own realm. See
  # docs/js-blocks.md.
  --pre-js ${CMAKE_CURRENT_SOURCE_DIR}/src/js_runtime.js
  # Diagnostics panel: injected into the page, survives Qt's html regeneration.
  --post-js ${CMAKE_CURRENT_SOURCE_DIR}/src/diag.js)

# Rebuild the link step when the injected JS changes (--pre-js/--post-js are not
# tracked deps).
set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS
  ${CMAKE_CURRENT_SOURCE_DIR}/src/diag.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/js_runtime.js)

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
          ${CMAKE_CURRENT_SOURCE_DIR}/src/gnuradio_world_logo.svg
          ${CMAKE_CURRENT_BINARY_DIR}/gnuradio_world_logo.svg
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/browser_file_reader.js
          ${CMAKE_CURRENT_BINARY_DIR}/browser_file_reader.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/browser_file_writer.js
          ${CMAKE_CURRENT_BINARY_DIR}/browser_file_writer.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_worklet.js
          ${CMAKE_CURRENT_BINARY_DIR}/audio_worklet.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/rtlsdr_reader.js
          ${CMAKE_CURRENT_BINARY_DIR}/rtlsdr_reader.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/plutosdr_worker.js
          ${CMAKE_CURRENT_BINARY_DIR}/plutosdr_worker.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/hackrf_worker.js
          ${CMAKE_CURRENT_BINARY_DIR}/hackrf_worker.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/gui_observation.js
          ${CMAKE_CURRENT_BINARY_DIR}/gui_observation.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/fosphor_webgpu.js
          ${CMAKE_CURRENT_BINARY_DIR}/fosphor_webgpu.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/spectrum_analyzer.js
          ${CMAKE_CURRENT_BINARY_DIR}/spectrum_analyzer.js
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          ${CMAKE_CURRENT_SOURCE_DIR}/src/js_runtime.js
          ${CMAKE_CURRENT_BINARY_DIR}/js_runtime.js
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          ${WORLD}/blocks/js
          ${CMAKE_CURRENT_BINARY_DIR}/js
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          ${CMAKE_CURRENT_SOURCE_DIR}/src/pyodide
          ${CMAKE_CURRENT_BINARY_DIR}/pyodide
  COMMENT "Patching runner.js addFunction signature default")
set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS
  ${CMAKE_CURRENT_SOURCE_DIR}/src/runner.html
  ${CMAKE_CURRENT_SOURCE_DIR}/src/gnuradio_world_logo.svg
  ${CMAKE_CURRENT_SOURCE_DIR}/src/browser_file_reader.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/browser_file_writer.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/audio_worklet.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/rtlsdr_reader.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/plutosdr_worker.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/hackrf_worker.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/gui_observation.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/fosphor_webgpu.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/spectrum_analyzer.js
  ${CMAKE_CURRENT_SOURCE_DIR}/src/pyodide/gr_pyodide_worker.js)

# ---------------------------------------------------------------------------
# The Embedded Python Block's worker and its Python shim (src/pyodide/), copied
# next to runner.html by the command above and served from there to *both*
# clients -- the runner iframe and the editor, which introspects a Python Block's
# source through the same worker.
#
# The worker fetches the shim by manifest rather than by a hard-coded list, and
# the manifest is generated here from what is actually in src/pyodide/py, so
# adding a module to the shim needs no second edit and cannot be half-done. This
# runs at configure time, so a *new* .py file needs a re-configure -- which
# CMakeLists.txt being a dependency of the build already forces.
# ---------------------------------------------------------------------------
# Package __init__.py files must be written before the modules inside them, so
# the sort matters: it puts gnuradio/__init__.py before gnuradio/gr/*.
file(GLOB_RECURSE PYODIDE_SHIM_FILES
     RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}/src/pyodide/py
     ${CMAKE_CURRENT_SOURCE_DIR}/src/pyodide/py/*.py)
list(SORT PYODIDE_SHIM_FILES)
# The copy above hangs off the link step, so the worker and the shim have to be
# link dependencies too -- otherwise editing one leaves the build tree serving
# the previous copy, with nothing to suggest the edit did not take.
foreach(shim ${PYODIDE_SHIM_FILES})
  set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS
    ${CMAKE_CURRENT_SOURCE_DIR}/src/pyodide/py/${shim})
endforeach()
# ---------------------------------------------------------------------------
# Repo JavaScript blocks (blocks/js/), copied next to runner.html by the command
# above. Fetched by id at run time rather than linked in, so a block's source never
# enters the wasm and editing one is a file copy. (Adding one still relinks: its id
# is in the generated generated_js_blocks.cpp, which is compiled in.)
#
# The manifest is generated here from what is actually in blocks/js. Nothing reads
# it at run time -- runner.html fetches by name from block_js_map() -- so it is
# informational only, and being a configure-time file(GLOB) it is stale until the
# next re-configure. Keep that in mind before making anything depend on it.
# ---------------------------------------------------------------------------
file(GLOB JS_BLOCK_FILES RELATIVE ${WORLD}/blocks/js ${WORLD}/blocks/js/*.js)
list(SORT JS_BLOCK_FILES)
foreach(js ${JS_BLOCK_FILES})
  set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS ${WORLD}/blocks/js/${js})
endforeach()
if(JS_BLOCK_FILES)
  string(REPLACE ";" "\",\n    \"" JS_BLOCK_JSON "${JS_BLOCK_FILES}")
  file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/js/manifest.json
       "{\n  \"files\": [\n    \"${JS_BLOCK_JSON}\"\n  ]\n}\n")
else()
  file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/js/manifest.json "{\n  \"files\": []\n}\n")
endif()

string(REPLACE ";" "\",\n    \"" PYODIDE_SHIM_JSON "${PYODIDE_SHIM_FILES}")
# Into the build tree, not next to the sources: it is a build output, and the
# copy_directory above leaves files the source tree does not have in place.
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/pyodide/py/manifest.json
     "{\n  \"files\": [\n    \"${PYODIDE_SHIM_JSON}\"\n  ]\n}\n")

# ---------------------------------------------------------------------------
# Category side modules: one WebAssembly SIDE_MODULE per deferred category. Each
# links only its own libgnuradio-<m>.a plus its generated self-registering
# factory table; every other symbol (runtime, VOLK, libc++, wasm_registry_add)
# stays undefined and is resolved against the main module at dlopen time. Built
# -O2 because these are the on-demand download payloads. No Qt — the block
# factories construct GR blocks only; GUI sinks stay in the core module.
# ---------------------------------------------------------------------------
# Assemble -I flags for the raw em++ side-module compile.
set(SIDE_INCLUDE_FLAGS "")
foreach(dir ${GR_INCLUDE_DIRS})
  list(APPEND SIDE_INCLUDE_FLAGS -I${dir})
endforeach()

# Every ordinary side module uses the same Emscripten ABI and exception flags.
# Keep that contract in one helper so a new category cannot quietly diverge.
function(add_side_module module)
  cmake_parse_arguments(SIDE "" "" "SOURCES;INCLUDE_DIRS;DEPENDS" ${ARGN})
  set(local_include_flags "")
  foreach(dir ${SIDE_INCLUDE_DIRS})
    list(APPEND local_include_flags -I${dir})
  endforeach()
  set(out ${CMAKE_CURRENT_BINARY_DIR}/${module}.wasm)
  add_custom_command(
    OUTPUT ${out}
    COMMAND ${CMAKE_CXX_COMPILER}
      -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
      -sNO_DISABLE_EXCEPTION_CATCHING
      # Must match the Qt-linked main module's i64 ABI.
      -sWASM_BIGINT=1
      ${local_include_flags}
      ${SIDE_INCLUDE_FLAGS}
      ${SIDE_SOURCES}
      -o ${out}
    DEPENDS ${SIDE_SOURCES} ${SIDE_DEPENDS}
            ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
            ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
    COMMENT "Building category side module ${module}.wasm"
    COMMAND_EXPAND_LISTS
    VERBATIM)
  list(APPEND SIDE_MODULE_OUTPUTS ${out})
  set(SIDE_MODULE_OUTPUTS ${SIDE_MODULE_OUTPUTS} PARENT_SCOPE)
  list(APPEND SIDE_MODULE_NAMES ${module})
  set(SIDE_MODULE_NAMES ${SIDE_MODULE_NAMES} PARENT_SCOPE)
endfunction()

set(SIDE_MODULE_OUTPUTS "")
set(SIDE_MODULE_NAMES "")
foreach(m ${IN_TREE_DEFERRED_MODULES})
  set(src ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_${m}.cpp)
  set(lib ${BUILDGR}/gr-${m}/lib/libgnuradio-${m}.a)
  add_side_module(${m} SOURCES ${src} ${lib})
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
set(RDS_WASM_SHIMS ${BLOCKS}/overlays/gr-rds/shims)
set(RDS_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_rds.cpp
  ${RDS_LIB}/decoder_impl.cc
  ${RDS_LIB}/encoder_impl.cc
  ${RDS_LIB}/parser_impl.cc
  ${RDS_LIB}/tag_to_msg_impl.cc)
add_side_module(rds
  SOURCES ${RDS_SOURCES}
  INCLUDE_DIRS ${RDS_WASM_SHIMS}
  DEPENDS ${RDS_WASM_SHIMS}/config.h ${RDS_WASM_SHIMS}/boost/locale.hpp)

# gr-foo: another out-of-tree module, handled exactly like gr-rds above — its own
# lib/*.cc are compiled straight into foo.wasm. selector/valve are Python
# hier_block2s (no C++) and are excluded; packet_pad2's optional UHD tx_time
# tagging is #ifdef FOO_UHD (undefined here), so no UHD dependency is pulled in.
# The submodule is pinned to pristine upstream, so the config.h its CMake would
# have generated comes from a runner-owned shim instead.
set(FOO_LIB ${WORLD}/gr-foo/lib)
set(FOO_WASM_SHIMS ${BLOCKS}/overlays/gr-foo/shims)
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
add_side_module(foo
  SOURCES ${FOO_SOURCES}
  INCLUDE_DIRS ${FOO_WASM_SHIMS}
  DEPENDS ${FOO_WASM_SHIMS}/config.h)

# gr-dvbs2 (drmpeg): another out-of-tree module, same treatment. bbheader_source
# is excluded — it is a UDP transport-stream source built on Boost.Asio (host
# networking), which has no meaning in the browser sandbox and is not in the WASM
# Boost set; it stays greyed out in the palette. The other 7 blocks form the
# DVB-S2 transmit chain (bbheader -> bbscrambler -> bch -> ldpc -> interleaver ->
# modulator -> physical). DVB-S2 constants come from the checked-in
# include/dvbs2/dvbs2_config.h; the config.h its CMake would have generated comes
# from a runner-owned shim, so the submodule carries only its WASM DSP fix.
set(DVBS2_LIB ${WORLD}/gr-dvbs2/lib)
set(DVBS2_WASM_SHIMS ${BLOCKS}/overlays/gr-dvbs2/shims)
set(DVBS2_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_dvbs2.cpp
  ${DVBS2_LIB}/bbheader_bb_impl.cc
  ${DVBS2_LIB}/bbscrambler_bb_impl.cc
  ${DVBS2_LIB}/bch_bb_impl.cc
  ${DVBS2_LIB}/ldpc_bb_impl.cc
  ${DVBS2_LIB}/interleaver_bb_impl.cc
  ${DVBS2_LIB}/modulator_bc_impl.cc
  ${DVBS2_LIB}/physical_cc_impl.cc)
add_side_module(dvbs2
  SOURCES ${DVBS2_SOURCES}
  INCLUDE_DIRS ${DVBS2_WASM_SHIMS}
  DEPENDS ${DVBS2_WASM_SHIMS}/config.h)

# gr-dvbs2rx (drmpeg): the DVB-S2/T2 receive-side FEC decoders (bbdeheader,
# bbdescrambler, bch_decoder, ldpc_decoder). Another OOT module, same treatment.
# Its LDPC/BCH decoder is a header-only SIMD library (lib/*.hh) that dispatches on
# __AVX2__/__SSE4_1__/__ARM_NEON__ — none defined under Emscripten, so it falls
# back to the generic scalar path (no x86 intrinsics). Deps are stdlib-only.
# DVB constants come from the checked-in include/dvbs2rx/dvb_config.h. The
# submodule is pinned to pristine upstream, so the config.h its CMake would have
# generated comes from a runner-owned shim instead.
set(DVBS2RX_LIB ${WORLD}/gr-dvbs2rx/lib)
set(DVBS2RX_WASM_SHIMS ${BLOCKS}/overlays/gr-dvbs2rx/shims)
set(DVBS2RX_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_dvbs2rx.cpp
  ${DVBS2RX_LIB}/bbdeheader_bb_impl.cc
  ${DVBS2RX_LIB}/bbdescrambler_bb_impl.cc
  ${DVBS2RX_LIB}/bch_decoder_bb_impl.cc
  ${DVBS2RX_LIB}/ldpc_decoder_cb_impl.cc)
add_side_module(dvbs2rx
  SOURCES ${DVBS2RX_SOURCES}
  INCLUDE_DIRS ${DVBS2RX_WASM_SHIMS}
  DEPENDS ${DVBS2RX_WASM_SHIMS}/config.h)

# gr-paint (drmpeg): the spectrum painter, which turns a stream of image luma
# bytes into a complex signal whose spectrogram draws the picture. One C++ block
# (paint_bc); its only deps are gr-fft and VOLK, both linked into the main
# module already, so there is no MODULE_DEPS edge. It includes "config.h" behind
# `#ifdef HAVE_CONFIG_H`, which nothing here defines, so unlike the other OOT
# modules it needs no config.h shim. paint_image_source is a PIL-based Python
# sync_block with no C++ path, so the browser decodes instead: it is rebuilt in
# blocks/overlays/gr-paint/paint_image_source.cpp and, being a CUSTOM_ID, is
# registered from the main module rather than from here.
set(PAINT_LIB ${WORLD}/gr-paint/lib)
set(PAINT_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_paint.cpp
  ${PAINT_LIB}/paint_bc_impl.cc)
add_side_module(paint SOURCES ${PAINT_SOURCES})

# gr-fosphor: upstream's overlap_cc stream operator is ordinary GNU Radio C++
# and builds directly into an on-demand side module. The embedded visualization
# sink depends on desktop OpenCL/OpenGL plus Qt5's QGLWidget, which does not fit
# the Qt6/WebGL browser runner. Its custom main-module factory prefers a browser
# WebGPU compute/render pipeline and automatically falls back to the Qt6
# spectrum/waterfall composition. The standalone GLFW sink is hidden.
set(FOSPHOR_LIB ${WORLD}/gr-fosphor/lib)
set(FOSPHOR_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_fosphor.cpp
  ${FOSPHOR_LIB}/overlap_cc_impl.cc)
add_side_module(fosphor SOURCES ${FOSPHOR_SOURCES})

# gr-ham (argilo): the only vendored OOT module with no C++ at all -- its lib/
# holds a CMakeLists.txt and nothing else, and all four blocks are Python
# gr.block subclasses. So this module has no vendored source to compile: the
# side module is the generated factory table over the browser rebuilds in
# blocks/overlays/gr-ham/ham_blocks.cpp, whose only dependency is the GNU Radio
# runtime already in the main module. ham_dstar_rx is not rebuilt and stays
# Python-only; see the note in that directory's metadata.yml.
set(HAM_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_ham.cpp
  ${BLOCKS}/overlays/gr-ham/ham_blocks.cpp)
add_side_module(ham
  SOURCES ${HAM_SOURCES}
  DEPENDS ${BLOCKS}/overlays/gr-ham/ham_blocks.hpp)

# gr-ieee802-11 (bastibl): the 802.11a/g/p transceiver. Every block in its grc/
# has a C++ impl, so this is the plain OOT case -- its own lib/*.cc compiled
# straight into the side module alongside the generated factory table. Its
# equalizer/ and viterbi_decoder/ headers are included relative to the sources,
# so lib/ needs no -I of its own. Two things to note:
#   * upstream selects an SSE2 Viterbi decoder when <xmmintrin.h> is found and
#     defines IEEE80211_MSSE2 to switch the header over. Emscripten defines
#     neither, so the generic scalar decoder is the one compiled here -- the same
#     situation as gr-dvbs2rx's SIMD headers, and it needs no flag.
#   * the module's constellations and signal_field derive from gr-digital's
#     `constellation` and `packet_header_default`, so it imports symbols from
#     another *deferred* module. That is what the "ieee802_11": ["digital"] edge
#     in modules.json is for; without it those imports never resolve at dlopen.
# config.h is only included behind HAVE_CONFIG_H, which nothing defines, so
# unlike most vendored modules this one needs no shim.
set(IEEE802_11_LIB ${WORLD}/gr-ieee802_11/lib)
set(IEEE802_11_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_ieee802_11.cpp
  ${IEEE802_11_LIB}/append_crc32_impl.cc
  ${IEEE802_11_LIB}/chunks_to_symbols_impl.cc
  ${IEEE802_11_LIB}/constellations_impl.cc
  ${IEEE802_11_LIB}/decode_mac.cc
  ${IEEE802_11_LIB}/equalizer/base.cc
  ${IEEE802_11_LIB}/equalizer/comb.cc
  ${IEEE802_11_LIB}/equalizer/lms.cc
  ${IEEE802_11_LIB}/equalizer/ls.cc
  ${IEEE802_11_LIB}/equalizer/sta.cc
  ${IEEE802_11_LIB}/ether_encap_impl.cc
  ${IEEE802_11_LIB}/extract_csi_impl.cc
  ${IEEE802_11_LIB}/frame_equalizer_impl.cc
  ${IEEE802_11_LIB}/mac.cc
  ${IEEE802_11_LIB}/mapper_impl.cc
  ${IEEE802_11_LIB}/parse_mac.cc
  ${IEEE802_11_LIB}/signal_field_impl.cc
  ${IEEE802_11_LIB}/sync_long.cc
  ${IEEE802_11_LIB}/sync_short.cc
  ${IEEE802_11_LIB}/utils.cc
  ${IEEE802_11_LIB}/viterbi_decoder/base.cc
  ${IEEE802_11_LIB}/viterbi_decoder/viterbi_decoder_generic.cc)
add_side_module(ieee802_11
  SOURCES ${IEEE802_11_SOURCES}
  DEPENDS ${BLOCKS}/overlays/gr-ieee802_11/ieee802_11_params.hpp)

# gr-ieee802-15-4 (bastibl): the IEEE 802.15.4 O-QPSK/CSS transceiver. All 25
# blocks exposed by its grc/ have native C++ implementations, so the complete
# lib/ source set is compiled directly into an on-demand side module. The
# module's README names gr-foo because its desktop transceiver examples use
# foo's Packet Pad and Wireshark Connector; none of this module's C++ sources
# imports gr-foo, so there is no deferred-module dependency edge. VOLK and
# gr-blocks are already in the main module. config.h is guarded by
# HAVE_CONFIG_H, which is not defined here, so no generated-header shim is
# needed. Generic matrix decoding handles the nested chip/codeword tables; the
# module-local parameter helper narrows the integer vectors used by RIME.
set(IEEE802_15_4_LIB ${WORLD}/gr-ieee802_15_4/lib)
set(IEEE802_15_4_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_ieee802_15_4.cpp
  ${IEEE802_15_4_LIB}/access_code_prefixer.cc
  ${IEEE802_15_4_LIB}/access_code_removal_b_impl.cc
  ${IEEE802_15_4_LIB}/bc_connection.cc
  ${IEEE802_15_4_LIB}/chips_to_bits_fb_impl.cc
  ${IEEE802_15_4_LIB}/codeword_demapper_ib_impl.cc
  ${IEEE802_15_4_LIB}/codeword_mapper_bi_impl.cc
  ${IEEE802_15_4_LIB}/codeword_soft_demapper_fb_impl.cc
  ${IEEE802_15_4_LIB}/deinterleaver_ff_impl.cc
  ${IEEE802_15_4_LIB}/dqcsk_demapper_cc_impl.cc
  ${IEEE802_15_4_LIB}/dqcsk_mapper_fc_impl.cc
  ${IEEE802_15_4_LIB}/dqpsk_mapper_ff_impl.cc
  ${IEEE802_15_4_LIB}/dqpsk_soft_demapper_cc_impl.cc
  ${IEEE802_15_4_LIB}/frame_buffer_cc_impl.cc
  ${IEEE802_15_4_LIB}/interleaver_ii_impl.cc
  ${IEEE802_15_4_LIB}/mac.cc
  ${IEEE802_15_4_LIB}/multiuser_chirp_detector_cc_impl.cc
  ${IEEE802_15_4_LIB}/packet_sink.cc
  ${IEEE802_15_4_LIB}/phr_prefixer_impl.cc
  ${IEEE802_15_4_LIB}/phr_removal_impl.cc
  ${IEEE802_15_4_LIB}/preamble_sfd_prefixer_ii_impl.cc
  ${IEEE802_15_4_LIB}/preamble_tagger_cc_impl.cc
  ${IEEE802_15_4_LIB}/qpsk_demapper_fi_impl.cc
  ${IEEE802_15_4_LIB}/qpsk_mapper_if_impl.cc
  ${IEEE802_15_4_LIB}/rime_connection.cc
  ${IEEE802_15_4_LIB}/rime_stack.cc
  ${IEEE802_15_4_LIB}/ruc_connection.cc
  ${IEEE802_15_4_LIB}/stubborn_sender.cc
  ${IEEE802_15_4_LIB}/uc_connection.cc
  ${IEEE802_15_4_LIB}/zeropadding_b_impl.cc
  ${IEEE802_15_4_LIB}/zeropadding_removal_b_impl.cc)
add_side_module(ieee802_15_4
  SOURCES ${IEEE802_15_4_SOURCES}
  DEPENDS ${BLOCKS}/overlays/gr-ieee802_15_4/ieee802_15_4_params.hpp)

# gr-droneid: proto17/dji_droneid keeps its GNU Radio OOT below
# gnuradio/gr-droneid in the repository. All five blocks have native C++
# implementations. The decoder also uses ttSou's small C turbofec library and
# header-only CRCpp; both are pinned by deps/fetch-deps.sh and compiled directly
# into this side module, so no host library or Python runtime is involved.
# Optional debug captures use a narrow Boost.Filesystem shim backed by
# Emscripten's virtual filesystem.
set(DRONEID_ROOT ${WORLD}/gr-droneid/gnuradio/gr-droneid)
set(DRONEID_LIB ${DRONEID_ROOT}/lib)
set(DRONEID_WASM_SHIMS ${BLOCKS}/overlays/gr-droneid/shims)
set(TURBOFEC_ROOT ${DEPS_SRC}/turbofec)
set(CRCPP_ROOT ${DEPS_SRC}/CRCpp)
set(DRONEID_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_droneid.cpp
  ${DRONEID_LIB}/misc_utils.cc
  ${BLOCKS}/overlays/gr-droneid/decode_impl.cc
  ${DRONEID_LIB}/demodulation_impl.cc
  ${DRONEID_LIB}/lte_decode.cc
  ${DRONEID_LIB}/extractor_impl.cc
  ${BLOCKS}/overlays/gr-droneid/normalized_xcorr_estimate_impl.cc
  ${DRONEID_LIB}/time_sync_impl.cc
  ${TURBOFEC_ROOT}/src/turbo_dec.c
  ${TURBOFEC_ROOT}/src/turbo_enc.c
  ${TURBOFEC_ROOT}/src/turbo_rate_match.c)
add_library(droneid_side_objects OBJECT EXCLUDE_FROM_ALL ${DRONEID_SOURCES})
set_target_properties(droneid_side_objects PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON)
target_include_directories(droneid_side_objects PRIVATE
  ${DRONEID_WASM_SHIMS}
  ${DRONEID_LIB}
  ${TURBOFEC_ROOT}/include
  ${TURBOFEC_ROOT}/src
  ${CRCPP_ROOT}/inc
  ${GR_INCLUDE_DIRS})
target_compile_options(droneid_side_objects PRIVATE
  -pthread -fPIC -Oz
  $<$<COMPILE_LANGUAGE:CXX>:-fexceptions>)
target_compile_definitions(droneid_side_objects PRIVATE
  M_PIf64=3.141592653589793238462643383279502884)
set(droneid_out ${CMAKE_CURRENT_BINARY_DIR}/droneid.wasm)
add_custom_command(
  OUTPUT ${droneid_out}
  COMMAND ${CMAKE_CXX_COMPILER}
    -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sWASM_BIGINT=1
    $<TARGET_OBJECTS:droneid_side_objects>
    -o ${droneid_out}
  DEPENDS droneid_side_objects
          ${DRONEID_SOURCES}
          ${DRONEID_WASM_SHIMS}/boost/filesystem.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module droneid.wasm (out-of-tree gr-droneid sources)"
  COMMAND_EXPAND_LISTS
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${droneid_out})
list(APPEND SIDE_MODULE_NAMES droneid)

# gr-satellites: telemetry framing, coding, FEC, and utility blocks. Like the
# other OOT modules, compile its implementation and bundled C/C++ codec sources
# directly into an on-demand side module. The upstream CMake build generates an
# otherwise empty config.h, supplied here as a runner-owned shim so the submodule
# can remain pinned to a pristine upstream branch.
set(SATELLITES_LIB ${WORLD}/gr-satellites/lib)
set(SATELLITES_WASM_SHIMS ${BLOCKS}/overlays/gr-satellites/shims)
set(SATELLITES_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_satellites.cpp
  ${BLOCKS}/overlays/gr-satellites/satellites_blocks.cpp
  ${BLOCKS}/overlays/gr-satellites/satellites_hier.cpp
  ${BLOCKS}/overlays/gr-satellites/satellites_deframers.cpp
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
          ${BLOCKS}/overlays/gr-satellites/satellites_blocks.hpp
          ${BLOCKS}/overlays/gr-satellites/satellites_hier.hpp
          ${BLOCKS}/overlays/gr-satellites/satellites_deframers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module satellites.wasm (out-of-tree gr-satellites sources)"
  COMMAND_EXPAND_LISTS
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${satellites_out})
list(APPEND SIDE_MODULE_NAMES satellites)

# gr-hrpt (altillimity): NOAA/MetOp/FengYun-3 HRPT downlink blocks (PLL, bit
# deframers, and the MetOp/FengYun rate-3/4 Viterbi decoders). Every block in
# its grc/ has a plain C++ impl, so this would ordinarily be the plain OOT
# case, except its Phil Karn-derived viterbi_lib/ is bundled C -- and
# add_side_module's custom command invokes em++ directly on every source
# regardless of extension, which silently compiles a .c file as C++
# ("treating 'c' input as 'c++' when in C++ mode"). That mangles viterbi_lib's
# C-linkage symbols against the extern "C" declarations the .cc impls call
# them through, so the dynamic link fails at dlopen with "bad export type for
# 'gen_met': undefined" instead of at compile time. Same reasoning as
# gr-droneid/gr-satellites' turbofec/libfec C sources: build via an OBJECT
# library so CMake picks emcc for .c files and em++ for .cc, then link the
# compiled objects into the side module. Its own CMake generates an empty
# config.h that every impl includes unconditionally (not behind
# HAVE_CONFIG_H), so it needs the same runner-owned shim as gr-rds/gr-dvbs2.
set(HRPT_LIB ${WORLD}/gr-hrpt/lib)
set(HRPT_WASM_SHIMS ${BLOCKS}/overlays/gr-hrpt/shims)
set(HRPT_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_hrpt.cpp
  ${HRPT_LIB}/noaa_hrpt_pll_cf_impl.cc
  ${HRPT_LIB}/noaa_hrpt_deframer_impl.cc
  ${HRPT_LIB}/noaa_hrpt_decoder_impl.cc
  ${HRPT_LIB}/viterbi_lib/metrics.c
  ${HRPT_LIB}/viterbi_lib/tab.c
  ${HRPT_LIB}/viterbi_lib/viterbi.c
  ${HRPT_LIB}/viterbi_metop_decoder_impl.cc
  ${HRPT_LIB}/viterbi_fengyun_decoder_impl.cc
  ${HRPT_LIB}/metop_cadu_deframer_impl.cc
  ${HRPT_LIB}/fengyun_diff_decoder_impl.cc)
add_library(hrpt_side_objects OBJECT EXCLUDE_FROM_ALL ${HRPT_SOURCES})
set_target_properties(hrpt_side_objects PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON)
target_include_directories(hrpt_side_objects PRIVATE
  ${HRPT_WASM_SHIMS}
  ${HRPT_LIB}
  ${GR_INCLUDE_DIRS})
target_compile_options(hrpt_side_objects PRIVATE
  -pthread -fPIC -Oz
  $<$<COMPILE_LANGUAGE:CXX>:-fexceptions>)
set(hrpt_out ${CMAKE_CURRENT_BINARY_DIR}/hrpt.wasm)
add_custom_command(
  OUTPUT ${hrpt_out}
  COMMAND ${CMAKE_CXX_COMPILER}
    -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sWASM_BIGINT=1
    $<TARGET_OBJECTS:hrpt_side_objects>
    -o ${hrpt_out}
  DEPENDS hrpt_side_objects
          ${HRPT_SOURCES}
          ${HRPT_WASM_SHIMS}/config.h
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module hrpt.wasm (out-of-tree gr-hrpt sources)"
  COMMAND_EXPAND_LISTS
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${hrpt_out})
list(APPEND SIDE_MODULE_NAMES hrpt)

# gr-lora_sdr (tapparelj/EPFL-TCL): a complete LoRa PHY -- whitening, header,
# CRC, Hamming, interleaver, gray (de)mapping, chirp modulator, and the
# frame_sync/fft_demod receiver front end. Every grc/ block except the lora_tx /
# lora_rx hierarchies has a C++ impl, so this is the ordinary OOT case, with one
# wrinkle: its bundled kiss_fft is C, and add_custom_command would invoke em++
# on it regardless of extension, mangling the symbols fft_demod_impl.cc calls
# through kiss_fft.h's `extern "C"` block -- a dlopen-time "bad export type for
# 'kiss_fft_alloc': undefined" rather than a compile error. Same reasoning as
# gr-hrpt's viterbi_lib and gr-satellites' libfec: build through an OBJECT
# library so CMake picks emcc for .c and em++ for .cc, then link the objects in.
# Its own CMake generates an empty config.h that every impl includes
# unconditionally, hence the runner-owned shim.
set(LORA_SDR_LIB ${WORLD}/gr-lora_sdr/lib)
set(LORA_SDR_WASM_SHIMS ${BLOCKS}/overlays/gr-lora_sdr/shims)
set(LORA_SDR_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_lora_sdr.cpp
  ${BLOCKS}/overlays/gr-lora_sdr/lora_sdr_hier.cpp
  ${LORA_SDR_LIB}/RH_RF95_header_impl.cc
  ${LORA_SDR_LIB}/add_crc_impl.cc
  ${LORA_SDR_LIB}/crc_verif_impl.cc
  ${LORA_SDR_LIB}/data_source_impl.cc
  ${LORA_SDR_LIB}/deinterleaver_impl.cc
  ${LORA_SDR_LIB}/dewhitening_impl.cc
  ${LORA_SDR_LIB}/fft_demod_impl.cc
  ${LORA_SDR_LIB}/frame_sync_impl.cc
  ${LORA_SDR_LIB}/gray_demap_impl.cc
  ${LORA_SDR_LIB}/gray_mapping_impl.cc
  ${LORA_SDR_LIB}/hamming_dec_impl.cc
  ${LORA_SDR_LIB}/hamming_enc_impl.cc
  ${LORA_SDR_LIB}/header_decoder_impl.cc
  ${LORA_SDR_LIB}/header_impl.cc
  ${LORA_SDR_LIB}/interleaver_impl.cc
  ${LORA_SDR_LIB}/kiss_fft.c
  ${LORA_SDR_LIB}/modulate_impl.cc
  ${LORA_SDR_LIB}/payload_id_inc_impl.cc
  ${LORA_SDR_LIB}/whitening_impl.cc)
add_library(lora_sdr_side_objects OBJECT EXCLUDE_FROM_ALL ${LORA_SDR_SOURCES})
set_target_properties(lora_sdr_side_objects PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON)
target_include_directories(lora_sdr_side_objects PRIVATE
  ${LORA_SDR_WASM_SHIMS}
  ${LORA_SDR_LIB}
  ${GR_INCLUDE_DIRS})
target_compile_options(lora_sdr_side_objects PRIVATE
  -pthread -fPIC -Oz
  $<$<COMPILE_LANGUAGE:CXX>:-fexceptions>)
set(lora_sdr_out ${CMAKE_CURRENT_BINARY_DIR}/lora_sdr.wasm)
add_custom_command(
  OUTPUT ${lora_sdr_out}
  COMMAND ${CMAKE_CXX_COMPILER}
    -sSIDE_MODULE=1 -pthread -fPIC -Oz -std=c++17
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sWASM_BIGINT=1
    $<TARGET_OBJECTS:lora_sdr_side_objects>
    -o ${lora_sdr_out}
  DEPENDS lora_sdr_side_objects
          ${LORA_SDR_SOURCES}
          ${LORA_SDR_WASM_SHIMS}/config.h
          ${BLOCKS}/overlays/gr-lora_sdr/lora_sdr_hier.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry_helpers.hpp
          ${CMAKE_CURRENT_SOURCE_DIR}/src/registry.hpp
  COMMENT "Building category side module lora_sdr.wasm (out-of-tree gr-lora_sdr sources)"
  COMMAND_EXPAND_LISTS
  VERBATIM)
list(APPEND SIDE_MODULE_OUTPUTS ${lora_sdr_out})
list(APPEND SIDE_MODULE_NAMES lora_sdr)

# gr-radar (kit-cel, the Communications Engineering Lab at KIT): CW / FMCW / FSK
# / OFDM / sync-pulse radar -- signal generators, a static target simulator, the
# matching estimators, OS-CFAR and a particle-filter tracker. Every block has a
# C++ impl, so this is the ordinary OOT case; its config.h include is behind
# `#ifdef HAVE_CONFIG_H`, which nothing defines, so like gr-paint it needs no
# shim. Three sources are left out of this list:
#   * usrp_echotimer_cc_impl.cc  -- UHD, which is not in the WASM sysroot.
#   * trigger_command_impl.cc    -- runs a shell command; a tab has no shell.
#   * qtgui_*_impl.cc plus their {time,scatter,spectrogram}_plot.cc widgets --
#     Q_OBJECT Qwt widgets, and there is no moc pass here. They are rebuilt in
#     blocks/overlays/gr-radar/radar_plots.cpp and, having hand-written
#     factories, register from the main module rather than from here.
# The first two also have no metadata.yml entry, so they stay greyed out.
set(RADAR_LIB ${WORLD}/gr-radar/lib)
set(RADAR_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_radar.cpp
  ${RADAR_LIB}/crop_matrix_vcvc_impl.cc
  ${RADAR_LIB}/estimator_cw_impl.cc
  ${RADAR_LIB}/estimator_fmcw_impl.cc
  ${RADAR_LIB}/estimator_fsk_impl.cc
  ${RADAR_LIB}/estimator_ofdm_impl.cc
  ${RADAR_LIB}/estimator_rcs_impl.cc
  ${RADAR_LIB}/estimator_sync_pulse_c_impl.cc
  ${RADAR_LIB}/find_max_peak_c_impl.cc
  ${RADAR_LIB}/msg_gate_impl.cc
  ${RADAR_LIB}/msg_manipulator_impl.cc
  ${RADAR_LIB}/ofdm_cyclic_prefix_remover_cvc_impl.cc
  ${RADAR_LIB}/ofdm_divide_vcvc_impl.cc
  ${RADAR_LIB}/os_cfar_2d_vc_impl.cc
  ${RADAR_LIB}/os_cfar_c_impl.cc
  ${RADAR_LIB}/print_results_impl.cc
  ${RADAR_LIB}/signal_generator_cw_c_impl.cc
  ${RADAR_LIB}/signal_generator_fmcw_c_impl.cc
  ${RADAR_LIB}/signal_generator_fsk_c_impl.cc
  ${RADAR_LIB}/signal_generator_sync_pulse_c_impl.cc
  ${RADAR_LIB}/split_cc_impl.cc
  ${RADAR_LIB}/split_fsk_cc_impl.cc
  ${RADAR_LIB}/static_target_simulator_cc_impl.cc
  ${RADAR_LIB}/tracking_singletarget_impl.cc
  ${RADAR_LIB}/transpose_matrix_vcvc_impl.cc
  ${RADAR_LIB}/ts_fft_cc_impl.cc)
add_side_module(radar
  SOURCES ${RADAR_SOURCES}
  INCLUDE_DIRS ${RADAR_LIB})

# gr-gsm (ptrkrysik): GSM burst acquisition, demapping, decryption and channel
# decoding. The upstream branch targets GNU Radio 3.11 and its native C++ blocks
# are portable; libosmocore is cross-built with its embedded profile and bundled
# pseudotalloc allocator. Host-file blocks (burst/message file source and sink)
# and TMSI Dumper are intentionally absent because their persistent filesystem
# behavior has no browser binding. Four Python hierarchies have no C++ source and
# are rebuilt in the overlay. The remaining native blocks share this side module.
set(GSM_LIB ${WORLD}/gr-gsm/lib)
set(GSM_OVERLAY ${BLOCKS}/overlays/gr-gsm)
set(GSM_WASM_SHIMS ${GSM_OVERLAY}/shims)
set(GSM_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/src/generated_registry_gsm.cpp
  ${GSM_OVERLAY}/gsm_hier.cpp
  ${GSM_OVERLAY}/pseudotalloc_shim.cc
  ${GSM_LIB}/decoding/control_channels_decoder_impl.cc
  ${GSM_LIB}/decoding/tch_f_decoder_impl.cc
  ${GSM_LIB}/decoding/tch_h_decoder_impl.cc
  ${BLOCKS}/overlays/gr-gsm/sch_decoder.cc
  ${GSM_LIB}/decoding/openbts/AmrCoder.cpp
  ${GSM_LIB}/decoding/openbts/BitVector.cpp
  ${GSM_LIB}/decoding/openbts/GSM503Tables.cpp
  ${GSM_LIB}/decoding/openbts/GSM610Tables.cpp
  ${GSM_LIB}/decoding/openbts/GSM660Tables.cpp
  ${GSM_LIB}/decoding/openbts/ViterbiR204.cpp
  ${GSM_LIB}/decryption/decryption_impl.cc
  ${GSM_LIB}/demapping/tch_f_chans_demapper_impl.cc
  ${GSM_LIB}/demapping/tch_h_chans_demapper_impl.cc
  ${GSM_LIB}/demapping/universal_ctrl_chans_demapper_impl.cc
  ${GSM_LIB}/misc_utils/bursts_printer_impl.cc
  ${GSM_LIB}/misc_utils/controlled_fractional_resampler_cc_impl.cc
  ${GSM_LIB}/misc_utils/controlled_rotator_cc_impl.cc
  ${GSM_LIB}/misc_utils/extract_assignment_cmd_impl.cc
  ${GSM_LIB}/misc_utils/extract_immediate_assignment_impl.cc
  ${GSM_LIB}/misc_utils/extract_system_info_impl.cc
  ${GSM_LIB}/misc_utils/message_printer_impl.cc
  ${GSM_LIB}/misc_utils/msg_to_tag_impl.cc
  ${GSM_LIB}/misc_utils/time_spec.cc
  ${GSM_LIB}/qa_utils/burst_sink_impl.cc
  ${GSM_LIB}/qa_utils/burst_source_impl.cc
  ${GSM_LIB}/qa_utils/message_sink_impl.cc
  ${GSM_LIB}/qa_utils/message_source_impl.cc
  ${GSM_LIB}/receiver/cx_channel_hopper_impl.cc
  ${GSM_LIB}/receiver/receiver_config.cc
  ${GSM_LIB}/receiver/receiver_impl.cc
  ${GSM_LIB}/receiver/viterbi_detector.cc
  ${SYSROOT}/lib/libosmocoding.a
  ${SYSROOT}/lib/libosmocodec.a
  ${SYSROOT}/lib/libosmogsm.a
  ${SYSROOT}/lib/libosmoisdn.a
  ${SYSROOT}/lib/libosmocore.a
  ${SYSROOT}/lib/libpseudotalloc.a)
add_side_module(gsm
  SOURCES ${GSM_SOURCES}
  INCLUDE_DIRS ${GSM_WASM_SHIMS} ${GSM_OVERLAY} ${GSM_LIB}
  DEPENDS ${GSM_WASM_SHIMS}/config.h
          ${GSM_WASM_SHIMS}/omp.h
          ${GSM_WASM_SHIMS}/gnuradio/gsm/endian.h)

# Fail at configure time if modules.json names a deferred category that has no
# build rule here, or if a build rule was added without registering its topology.
set(expected_side_modules ${ALL_DEFERRED_MODULES})
set(actual_side_modules ${SIDE_MODULE_NAMES})
list(SORT expected_side_modules)
list(SORT actual_side_modules)
if(NOT "${actual_side_modules}" STREQUAL "${expected_side_modules}")
  message(FATAL_ERROR
    "Deferred module mismatch: modules.json=[${expected_side_modules}], "
    "CMake=[${actual_side_modules}]")
endif()

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
