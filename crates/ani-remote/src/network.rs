use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr};

use url::Url;

/// 反向代理显式允许的公网同源地址。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedOrigin {
    pub origin: String,
    pub scheme: String,
    pub hostname: String,
    pub port: u16,
}

/// 返回当前网卡可供局域网客户端访问的 RFC1918 IPv4 地址。
pub fn list_private_ipv4_addresses() -> Vec<Ipv4Addr> {
    let mut addresses = BTreeSet::new();
    match if_addrs::get_if_addrs() {
        Ok(interfaces) => {
            for interface in interfaces {
                if interface.is_loopback() {
                    continue;
                }
                if let IpAddr::V4(address) = interface.ip() {
                    if is_private_ipv4(address) {
                        addresses.insert(address);
                    }
                }
            }
        }
        Err(error) => log::warn!("读取局域网网卡失败 error={error}"),
    }
    addresses.into_iter().collect()
}

/// 判断地址是否属于 RFC1918 私有 IPv4 网段。
pub fn is_private_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, _, _] = address.octets();
    first == 10 || (first == 172 && (16..=31).contains(&second)) || (first == 192 && second == 168)
}

/// 解析逗号分隔的反向代理公网 Origin 白名单。
pub fn parse_trusted_origins(value: Option<&str>) -> Vec<TrustedOrigin> {
    let mut origins = BTreeSet::new();
    let mut parsed = Vec::new();
    for candidate in value
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let Ok(url) = Url::parse(candidate) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            continue;
        }
        let Some(hostname) = url.host_str().map(str::to_ascii_lowercase) else {
            continue;
        };
        let Some(port) = url.port_or_known_default() else {
            continue;
        };
        let origin = format!("{}://{}:{}", url.scheme(), hostname, port);
        if origins.insert(origin.clone()) {
            parsed.push(TrustedOrigin {
                origin,
                scheme: url.scheme().to_owned(),
                hostname,
                port,
            });
        }
    }
    parsed
}

/// 校验 Host 与当前监听地址或显式反向代理 Origin 精确匹配。
pub(crate) fn is_trusted_host(
    value: Option<&str>,
    local_port: u16,
    allowed_local_hosts: &[String],
    trusted_origins: &[TrustedOrigin],
) -> bool {
    let Some(value) = value else {
        return false;
    };
    if value
        .chars()
        .any(|character| matches!(character, '@' | '/' | '?' | '#'))
    {
        return false;
    }
    parse_host(value, "https").is_some_and(|(hostname, port)| {
        (port == local_port
            && allowed_local_hosts
                .iter()
                .any(|allowed| allowed == &hostname))
            || trusted_origins
                .iter()
                .any(|trusted| trusted.hostname == hostname && trusted.port == port)
    })
}

/// 校验浏览器 Origin 为本地同源或显式允许的公网同源地址。
pub(crate) fn is_trusted_origin(
    value: Option<&str>,
    local_scheme: &str,
    local_port: u16,
    allowed_local_hosts: &[String],
    trusted_origins: &[TrustedOrigin],
) -> bool {
    let Some(value) = value else {
        return true;
    };
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Some(hostname) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    let Some(port) = url.port_or_known_default() else {
        return false;
    };
    (url.scheme() == local_scheme
        && port == local_port
        && allowed_local_hosts
            .iter()
            .any(|allowed| allowed == &hostname))
        || trusted_origins.iter().any(|trusted| {
            trusted.scheme == url.scheme()
                && trusted.hostname == hostname
                && trusted.port == port
                && trusted.origin.eq_ignore_ascii_case(&format!(
                    "{}://{}:{}",
                    url.scheme(),
                    hostname,
                    port
                ))
        })
}

fn parse_host(value: &str, scheme: &str) -> Option<(String, u16)> {
    let url = Url::parse(&format!("{scheme}://{value}")).ok()?;
    if !url.username().is_empty() || url.password().is_some() || url.path() != "/" {
        return None;
    }
    Some((
        url.host_str()?.to_ascii_lowercase(),
        url.port_or_known_default()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证仅接受 RFC1918 IPv4 地址。
    #[test]
    fn identifies_private_ipv4_ranges() {
        assert!(is_private_ipv4(Ipv4Addr::new(10, 1, 2, 3)));
        assert!(is_private_ipv4(Ipv4Addr::new(172, 31, 1, 1)));
        assert!(is_private_ipv4(Ipv4Addr::new(192, 168, 1, 1)));
        assert!(!is_private_ipv4(Ipv4Addr::new(172, 32, 1, 1)));
        assert!(!is_private_ipv4(Ipv4Addr::new(8, 8, 8, 8)));
    }

    /// 验证 Host 和 Origin 均要求精确协议、主机与端口。
    #[test]
    fn validates_host_and_origin() {
        let local = vec!["127.0.0.1".to_owned(), "localhost".to_owned()];
        let trusted = parse_trusted_origins(Some("https://remote.example.com"));
        assert!(is_trusted_host(
            Some("127.0.0.1:18083"),
            18083,
            &local,
            &trusted
        ));
        assert!(!is_trusted_host(
            Some("evil.test:18083"),
            18083,
            &local,
            &trusted
        ));
        assert!(is_trusted_origin(
            Some("http://localhost:18083"),
            "http",
            18083,
            &local,
            &trusted
        ));
        assert!(is_trusted_origin(
            Some("https://remote.example.com"),
            "http",
            18083,
            &local,
            &trusted
        ));
        assert!(!is_trusted_origin(
            Some("https://remote.example.com/path"),
            "http",
            18083,
            &local,
            &trusted
        ));
    }
}
