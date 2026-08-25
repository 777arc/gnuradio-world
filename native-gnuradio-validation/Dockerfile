FROM ubuntu:26.04

ARG DEBIAN_FRONTEND=noninteractive

# Keep this image deliberately independent of GNU Radio World's Emscripten,
# runner, and editor dependency trees.  sudo is installed first so the GNU
# Radio installation uses the same command as a normal Ubuntu host setup.
RUN apt-get update \
    && apt-get install -y --no-install-recommends sudo \
    && sudo apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        gnuradio \
        gnuradio-dev \
        libqwt-qt5-dev \
        python3 \
        python3-yaml \
        qtbase5-dev \
        xauth \
        xvfb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home validator

COPY validate_flowgraphs.py /usr/local/bin/validate-flowgraphs
RUN chmod 0755 /usr/local/bin/validate-flowgraphs

USER validator
WORKDIR /work

ENV HOME=/home/validator \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["validate-flowgraphs"]
CMD ["/flowgraphs"]
