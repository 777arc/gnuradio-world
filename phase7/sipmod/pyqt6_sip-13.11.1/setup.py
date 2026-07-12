# SPDX-License-Identifier: BSD-2-Clause

# Copyright (c) 2025 Phil Thompson <phil@riverbankcomputing.com>


import glob

from setuptools import Extension, setup


# Build the extension module.
module_src = sorted(glob.glob('*.c'))

module = Extension('PyQt6.sip', module_src)

# Do the setup.
setup(
        name='PyQt6_sip',
        version='13.11.1',
        license='BSD-2-Clause',
        python_requires='>=3.10',
        ext_modules=[module]
     )
