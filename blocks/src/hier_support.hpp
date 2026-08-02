#pragma once

// Shared by the block rebuilds in this directory: a constant and an argument
// check several of them need, which would otherwise be duplicated per module.

#include <cmath>
#include <stdexcept>
#include <string>

constexpr double PI = 3.141592653589793238462643383279502884;

inline void require_positive(const char* name, double value)
{
    if (!std::isfinite(value) || value <= 0.0)
        throw std::runtime_error(std::string(name) + " must be positive");
}
