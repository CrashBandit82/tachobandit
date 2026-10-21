# Build tachobandit inside the tachoparser source tree so it can use the
# embedded ERCA/MSCA certificates (internal package) for signature checks.
FROM golang:1.24-alpine AS build
ARG TACHOPARSER_COMMIT=f108ac4adac4c5c65c6b232b440b209c1e0a99e4
ARG SCARD_COMMIT=7af069cabc25c2ba8051ea6216c0eb0d376f95fb
RUN apk add --no-cache git gcc musl-dev pkgconf pcsc-lite-dev \
 && git init -q /src && cd /src \
 && git fetch -q --depth 1 https://github.com/traconiq/tachoparser "$TACHOPARSER_COMMIT" \
 && git checkout -q FETCH_HEAD
WORKDIR /src
COPY certs/pks1/ internal/pkg/certificates/pks1/
COPY certs/pks2/ internal/pkg/certificates/pks2/
RUN go get github.com/ebfe/scard@"$SCARD_COMMIT"
COPY server/ cmd/tachobandit/
RUN cd cmd/tachobandit && CGO_ENABLED=1 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /tachobandit .

FROM alpine:3.22
# pcsc-lite-libs: client library for the host pcscd (chip card reader)
RUN apk add --no-cache pcsc-lite-libs
RUN adduser -D -u 1000 tacho && mkdir /data && chown tacho /data
COPY --from=build /tachobandit /usr/local/bin/tachobandit
USER tacho
VOLUME /data
EXPOSE 8080
CMD ["tachobandit"]
