#pragma once

// GNU Radio removed __GR_VLA after gr-lte's GNU Radio 3.10 port was written.
// Preserve the old call sites with standard C++ storage while keeping the
// pristine upstream submodule untouched.
#include <cstddef>
#include <vector>

#ifndef __GR_VLA
#define __GR_VLA(type, name, count)                                             \
    std::vector<type> name##_storage(static_cast<std::size_t>(count));          \
    type* name = name##_storage.data()
#endif
