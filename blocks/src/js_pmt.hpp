// Synchronous PMT bridge for the JavaScript Block. See docs/js-blocks.md.
#pragma once

#include <pmt/pmt.h>

namespace grworld {

// One arena is active for the duration of an outer C++ -> JavaScript crossing.
// Handles are never exposed to block authors and are invalid after this scope.
class JsPmtArenaScope
{
public:
    JsPmtArenaScope();
    ~JsPmtArenaScope();
    JsPmtArenaScope(const JsPmtArenaScope&) = delete;
    JsPmtArenaScope& operator=(const JsPmtArenaScope&) = delete;
};

int js_pmt_add(const pmt::pmt_t& value);
const pmt::pmt_t& js_pmt_get(int handle);

} // namespace grworld
