# cmake -DSRC=<dir> -DDST=<dir> -P copy_dir_if_exists.cmake
#
# Mirror SRC into DST when SRC exists, and do nothing otherwise. Neither
# `-E copy_directory` nor `-E copy_directory_if_different` is a no-op on a
# missing source: both exit 1, which fails the POST_BUILD step for every tree
# that skipped an optional fetch. Decided at build time rather than with
# if(EXISTS) at configure time, so fetching the source later needs no reconfigure.
if(NOT IS_DIRECTORY "${SRC}")
  return()
endif()
file(GLOB_RECURSE files RELATIVE "${SRC}" "${SRC}/*")
foreach(rel IN LISTS files)
  get_filename_component(dir "${DST}/${rel}" DIRECTORY)
  file(MAKE_DIRECTORY "${dir}")
  execute_process(COMMAND "${CMAKE_COMMAND}" -E copy_if_different
                          "${SRC}/${rel}" "${DST}/${rel}"
                  RESULT_VARIABLE rc)
  if(NOT rc EQUAL 0)
    message(FATAL_ERROR "copying ${SRC}/${rel} -> ${DST}/${rel} failed")
  endif()
endforeach()
