package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// IrcConnectionSpec defines the configuration for a single IRC connection
type IrcConnectionSpec struct {
	Name        string                  `json:"name,omitempty"`
	IRCSpec     IRCServerConnectionSpec `json:"irc,omitempty"`
	Ident       IdentSpec               `json:"ident,omitempty"`
	PostConnect PostConnectSpec         `json:"postConnect,omitempty"`
}

// IRCServerConnectionSpec defines the detailed IRC Connection configuration
type IRCServerConnectionSpec struct {
	Host                    string `json:"host,omitempty"`
	Port                    int    `json:"port,omitempty"`
	SSL                     bool   `json:"ssl,omitempty"`
	AutoReconnect           bool   `json:"autoReconnect,omitempty"`
	AutoReconnectWait       int    `json:"autoReconnectWait,omitempty"`
	AutoReconnectMaxRetries int    `json:"autoReconnectMaxRetries,omitempty"`
	AutoRejoin              bool   `json:"autoRejoin,omitempty"`
	AutoRejoinWait          int    `json:"autoRejoinWait,omitempty"`
	AutoRejoinMaxRetries    int    `json:"autoRejoinMaxRetries,omitempty"`
	PingInterval            int    `json:"pingInterval,omitempty"`
	PingTimeout             int    `json:"pingTimeout,omitempty"`
}

// IdentSpec defines the IRC ident configuration
type IdentSpec struct {
	Nick     string `json:"nick,omitempty"`
	Username string `json:"username,omitempty"`
	Gecos    string `json:"gecos,omitempty"`
	Version  string `json:"version,omitempty"`
}

// PostConnectSpec defines the post-connect actions
type PostConnectSpec struct {
	Join    []PostConnectJoinSpec    `json:"join,omitempty"`
	Message []PostConnectMessageSpec `json:"message,omitempty"`
	Mode    []PostConnectModeSpec    `json:"mode,omitempty"`
	Raw     []PostConnectRawSpec     `json:"raw,omitempty"`
}

// MessageSpec defines the message actions
type PostConnectMessageSpec struct {
	Sequence int    `json:"sequence,omitempty"`
	Target   string `json:"target,omitempty"`
	Msg      string `json:"msg,omitempty"`
}

// ModeSpec defines the mode actions
type PostConnectModeSpec struct {
	Sequence int    `json:"sequence,omitempty"`
	Target   string `json:"target,omitempty"`
	Mode     string `json:"mode,omitempty"`
}

// RawSpec defines the raw actions
type PostConnectRawSpec struct {
	Sequence int    `json:"sequence,omitempty"`
	Raw      string `json:"raw,omitempty"`
}

// JoinSpec defines the join actions
type PostConnectJoinSpec struct {
	Sequence int           `json:"sequence,omitempty"`
	Channels []ChannelSpec `json:"channels,omitempty"`
}

// ChannelSpec defines the channels to join
type ChannelSpec struct {
	Channel string `json:"channel,omitempty"`
	Key     string `json:"key,omitempty"`
}

// ConnectorIrcSpec defines the desired state of ConnectorIrc
type ConnectorIrcSpec struct {
	// Size defines the number of ConnectorIrc instances
	// The following markers will use OpenAPI v3 schema to validate the value
	// More info: https://book.kubebuilder.io/reference/markers/crd-validation.html
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=1
	// +kubebuilder:validation:ExclusiveMaximum=false
	// +kubebuilder:default=1
	Size int32 `json:"size,omitempty"`

	// ContainerImage defines the container image to use
	// +kubebuilder:default="ghcr.io/eeveebot/connector-irc:latest"
	ContainerImage string `json:"containerImage,omitempty"`

	// PullPolicy defines the imagepullpolicy to use
	// +kubebuilder:default=Always
	PullPolicy string `json:"pullPolicy,omitempty"`

	// Connections defines IRC Connections for the connector
	Connections []IrcConnectionSpec `json:"ircConnections,omitempty"`
}

// ConnectorIrcStatus defines the observed state of ConnectorIrc
type ConnectorIrcStatus struct {
	// Represents the observations of a ConnectorIrc's current state.
	// ConnectorIrc.status.conditions.type are: "Available", "Progressing", and "Degraded"
	// ConnectorIrc.status.conditions.status are one of True, False, Unknown.
	// ConnectorIrc.status.conditions.reason the value should be a CamelCase string and producers of specific
	// condition types may define expected values and meanings for this field, and whether the values
	// are considered a guaranteed API.
	// ConnectorIrc.status.conditions.Message is a human readable message indicating details about the transition.
	// For further information see: https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties

	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type" protobuf:"bytes,1,rep,name=conditions"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// ConnectorIrc is the Schema for the connectorircs API
type ConnectorIrc struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ConnectorIrcSpec   `json:"spec,omitempty"`
	Status ConnectorIrcStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// ConnectorIrcList contains a list of ConnectorIrc
type ConnectorIrcList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ConnectorIrc `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ConnectorIrc{}, &ConnectorIrcList{})
}
