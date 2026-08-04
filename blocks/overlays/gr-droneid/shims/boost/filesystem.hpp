#pragma once

// gr-droneid uses only this narrow slice of Boost.Filesystem for optional
// debug captures. Keep the upstream module pristine and map those calls to the
// browser runtime's POSIX-backed Emscripten filesystem instead of pulling the
// full Boost.Filesystem library into the side module.

#include <cerrno>
#include <string>
#include <sys/stat.h>

namespace boost::filesystem {

class path
{
public:
    path() = default;
    path(const std::string& value) : value_(value) {}
    path(const char* value) : value_(value ? value : "") {}

    std::string string() const { return value_; }

    friend path operator/(const path& lhs, const path& rhs)
    {
        if (lhs.value_.empty())
            return rhs;
        if (rhs.value_.empty())
            return lhs;
        return path(lhs.value_ + (lhs.value_.back() == '/' ? "" : "/") + rhs.value_);
    }

private:
    std::string value_;
};

inline bool is_directory(const path& value)
{
    struct stat info {};
    return stat(value.string().c_str(), &info) == 0 && S_ISDIR(info.st_mode);
}

inline bool create_directories(const path& value)
{
    const std::string full = value.string();
    if (full.empty() || is_directory(value))
        return false;

    std::string current;
    if (full.front() == '/')
        current = "/";
    for (std::size_t start = current.size(); start <= full.size();) {
        const std::size_t slash = full.find('/', start);
        const std::string part = full.substr(start, slash - start);
        if (!part.empty()) {
            if (!current.empty() && current.back() != '/')
                current += '/';
            current += part;
            if (mkdir(current.c_str(), 0777) != 0 && errno != EEXIST)
                return false;
        }
        if (slash == std::string::npos)
            break;
        start = slash + 1;
    }
    return is_directory(value);
}

} // namespace boost::filesystem
