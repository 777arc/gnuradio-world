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

set(GR /home/marc/gnuradio)
set(BUILDGR ${GR}/wasm/gr/build-gr)
set(SYSROOT ${GR}/wasm/sysroot)
set(QTGUI_TS ${GR}/wasm/qtgui/build/libgr_qtgui_ts.a)

# Include search path shared by the main module and the category side modules.
set(GR_INCLUDE_DIRS
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${GR}/gnuradio-runtime/include ${GR}/gr-blocks/include ${GR}/gr-fft/include
  ${GR}/gr-filter/include ${GR}/gr-analog/include ${GR}/gr-digital/include
  ${GR}/gr-fec/include ${GR}/gr-dtv/include
  ${GR}/gr-network/include ${GR}/gr-pdu/include ${GR}/gr-vocoder/include
  ${GR}/gr-qtgui/include
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
  src/generated_registry.cpp
  src/generated_modules.cpp)
target_include_directories(runner PRIVATE ${GR_INCLUDE_DIRS})
target_compile_options(runner PRIVATE -fPIC)

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
  # gr-digital is a deferred side module, but the hand-written digital_psk_mod
  # factory in registry.cpp (core) uses map_bb/diff_encoder_bb/chunks_to_symbols.
  # Link it normally so only those few objects are pulled into core; the other
  # ~35 digital blocks remain solely in digital.wasm.
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
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,stringToNewUTF8,UTF8ToString
  # Diagnostics panel: injected into the page, survives Qt's html regeneration.
  --post-js ${CMAKE_CURRENT_SOURCE_DIR}/src/diag.js)

# Rebuild the link step when the panel JS changes (--post-js isn't a tracked dep).
set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/diag.js)

# Patch the generated runner.js for the Qt+MAIN_MODULE addFunction-signature bug.
add_custom_command(TARGET runner POST_BUILD
  COMMAND python3 ${CMAKE_CURRENT_SOURCE_DIR}/src/patch_runner_js.py
          ${CMAKE_CURRENT_BINARY_DIR}/runner.js
  COMMENT "Patching runner.js addFunction signature default")

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
      -sSIDE_MODULE=1 -pthread -fPIC -O2 -std=c++17
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
